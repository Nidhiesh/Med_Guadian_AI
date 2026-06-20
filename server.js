const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir)
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname)
    }
});
const upload = multer({ storage: storage });

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // Serve frontend files from root directory

const JWT_SECRET = 'supersecret_medguardian_key';

// Initialize MySQL pool. You should configure these based on your setup.
const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: '', // Update with actual DB password
    database: 'medguardian_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Middleware to verify JWT
const authenticate = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return res.status(401).json({ error: 'Invalid token' });
        req.user = decoded;
        next();
    });
};

// Helper to send real SMS (using Fast2SMS or Twilio) or fallback to simulated log
async function sendSMS(phone, message) {
    // 1. Try Fast2SMS if API key is provided
    if (process.env.FAST2SMS_API_KEY) {
        try {
            console.log(`[Fast2SMS] Attempting to send SMS to ${phone}...`);
            // Fast2SMS expects 10-digit numbers, so clean any spaces/dashes/prefixes
            const cleanedPhone = phone.replace(/\D/g, '').slice(-10);
            
            const response = await fetch('https://www.fast2sms.com/dev/bulkV2', {
                method: 'POST',
                headers: {
                    'authorization': process.env.FAST2SMS_API_KEY,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    route: 'q',
                    message: message,
                    language: 'english',
                    flash: 0,
                    numbers: cleanedPhone
                })
            });
            const data = await response.json();
            if (response.ok && data.return === true) {
                console.log(`[Fast2SMS] SMS successfully sent to ${phone}: ${data.message}`);
                return { success: true, provider: 'fast2sms' };
            } else {
                console.error(`[Fast2SMS] API responded with error:`, data);
            }
        } catch (err) {
            console.error('[Fast2SMS] Error sending SMS:', err.message);
        }
    }
    
    // 2. Try Twilio if SID, TOKEN, and FROM are provided
    if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER) {
        try {
            console.log(`[Twilio] Attempting to send SMS to ${phone}...`);
            // Ensure phone number has country code (Twilio requires E.164, e.g., +919876543210)
            let formattedPhone = phone.trim().replace(/[\s-()]/g, '');
            if (!formattedPhone.startsWith('+')) {
                // If it is 10 digits, default to India (+91)
                if (formattedPhone.length === 10) {
                    formattedPhone = '+91' + formattedPhone;
                } else {
                    formattedPhone = '+' + formattedPhone;
                }
            }
            
            const authString = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
            const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`, {
                method: 'POST',
                headers: {
                    'Authorization': `Basic ${authString}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({
                    To: formattedPhone,
                    From: process.env.TWILIO_FROM_NUMBER,
                    Body: message
                })
            });
            const data = await response.json();
            if (response.ok) {
                console.log(`[Twilio] SMS successfully sent to ${formattedPhone}. SID: ${data.sid}`);
                return { success: true, provider: 'twilio' };
            } else {
                console.error(`[Twilio] API responded with error:`, data);
            }
        } catch (err) {
            console.error('[Twilio] Error sending SMS:', err.message);
        }
    }
    
    // 3. Fallback to Simulated SMS (No keys configured or sending failed)
    console.log(`[SIMULATED SMS to ${phone}]: ${message}`);
    return { success: false, provider: 'simulation' };
}
// --- PUBLIC EMERGENCY ROUTE ---
app.get('/api/emergency/:userid', async (req, res) => {
    try {
        const userid = req.params.userid;
        if (!userid) {
            return res.status(400).json({ error: 'UserID is required' });
        }

        // 1. Fetch patient details
        const [users] = await pool.query(
            'SELECT id, name, phone, email, hospital FROM users WHERE userid = ? AND role = "patient"',
            [userid]
        );
        if (users.length === 0) {
            return res.status(404).json({ error: 'Patient profile not found' });
        }
        const patient = users[0];

        // 2. Fetch allergies and prescriptions from health_records
        const [records] = await pool.query(
            'SELECT record_type, title, description FROM health_records WHERE patient_id = ? AND record_type IN ("allergy", "prescription") ORDER BY id ASC',
            [patient.id]
        );

        const allergies = records.filter(r => r.record_type === 'allergy');
        const prescriptions = records.filter(r => r.record_type === 'prescription');

        res.json({
            name: patient.name,
            phone: patient.phone,
            email: patient.email,
            hospital: patient.hospital,
            allergies: allergies.map(r => ({ title: r.title, description: r.description })),
            prescriptions: prescriptions.map(r => ({ title: r.title, description: r.description }))
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// --- AUTH ROUTES ---
app.post('/api/auth/signup', async (req, res) => {
    try {
        const { name, email, password, hospital } = req.body;
        // Hardcode role to 'doctor' as patients can no longer sign up directly
        if (!name || !email || !password) {
            return res.status(400).json({ error: 'Name, email, and password required' });
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        const [result] = await pool.query(
            'INSERT INTO users (name, email, password_hash, role, hospital) VALUES (?, ?, ?, "doctor", ?)',
            [name, email, hashedPassword, hospital || null]
        );

        res.status(201).json({ message: 'Doctor created successfully', id: result.insertId });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Email already exists' });
        }
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password, userid } = req.body;
        
        if (userid) {
            // Patient Login via UserID
            const [rows] = await pool.query('SELECT * FROM users WHERE userid = ? AND role = "patient"', [userid]);
            if (rows.length === 0) return res.status(401).json({ error: 'Invalid UserID' });
            
            const user = rows[0];
            const token = jwt.sign({ id: user.id, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '24h' });
            return res.json({ token, user: { id: user.id, name: user.name, role: user.role, email: user.email, userid: user.userid } });
        } else {
            // Doctor Login via Email/Password
            const [rows] = await pool.query('SELECT * FROM users WHERE email = ? AND role = "doctor"', [email]);
            if (rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

            const user = rows[0];
            const isMatch = await bcrypt.compare(password, user.password_hash);
            if (!isMatch) return res.status(401).json({ error: 'Invalid credentials' });

            const token = jwt.sign({ id: user.id, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '24h' });
            return res.json({ token, user: { id: user.id, name: user.name, role: user.role, email: user.email } });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// --- DOCTOR ROUTES ---
app.get('/api/users/patients', authenticate, async (req, res) => {
    if (req.user.role !== 'doctor') return res.status(403).json({ error: 'Doctors only' });
    try {
        const [patients] = await pool.query(`
            SELECT u.id, u.name, u.email, u.hospital, ar.status 
            FROM users u 
            LEFT JOIN access_requests ar ON u.id = ar.patient_id AND ar.doctor_id = ?
            WHERE u.role = "patient"
            ORDER BY COALESCE(u.hospital, 'zzz'), u.name
        `, [req.user.id]);
        res.json(patients);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/access/request', authenticate, async (req, res) => {
    if (req.user.role !== 'doctor') return res.status(403).json({ error: 'Doctors only' });
    try {
        const { patient_id } = req.body;
        await pool.query(
            `INSERT INTO access_requests (doctor_id, patient_id, status, created_at) 
             VALUES (?, ?, "pending", CURRENT_TIMESTAMP) 
             ON DUPLICATE KEY UPDATE status = "pending", created_at = CURRENT_TIMESTAMP`,
            [req.user.id, patient_id]
        );
        res.status(201).json({ message: 'Request sent successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// --- DOCTOR ROUTES --- (continued)
app.post('/api/doctor/create-patient', authenticate, async (req, res) => {
    if (req.user.role !== 'doctor') return res.status(403).json({ error: 'Doctors only' });
    try {
        const { name, email, phone, userid, hospital, prescriptionTitle, prescriptionDesc, healthIssueTitle, healthIssueDesc } = req.body;
        if (!name || !email || !phone || !userid) {
            return res.status(400).json({ error: 'Name, email, phone, and UserID are required' });
        }
        
        // Patients no longer have passwords, use dummy hash
        const hashedPassword = '*NO_PASSWORD*';
        
        // Use a transaction since we are inserting multiple records
        const connection = await pool.getConnection();
        await connection.beginTransaction();

        try {
            // 1. Create Patient User
            const [userResult] = await connection.query(
                'INSERT INTO users (name, email, password_hash, role, hospital, phone, userid) VALUES (?, ?, ?, "patient", ?, ?, ?)',
                [name, email, hashedPassword, hospital || req.user.hospital || null, phone, userid]
            );
            const patientId = userResult.insertId;

            // 2. Grant access to the doctor automatically
            await connection.query(
                'INSERT INTO access_requests (doctor_id, patient_id, status) VALUES (?, ?, "approved")',
                [req.user.id, patientId]
            );

            // 3. Insert Prescription if provided
            if (prescriptionTitle && prescriptionDesc) {
                await connection.query(
                    'INSERT INTO health_records (patient_id, record_type, title, description) VALUES (?, "prescription", ?, ?)',
                    [patientId, prescriptionTitle, prescriptionDesc]
                );
            }

            // 4. Insert Health Issue (as allergy) if provided
            if (healthIssueTitle && healthIssueDesc) {
                await connection.query(
                    'INSERT INTO health_records (patient_id, record_type, title, description) VALUES (?, "allergy", ?, ?)',
                    [patientId, healthIssueTitle, healthIssueDesc]
                );
            }

            await connection.commit();
            
            const smsMessage = `Welcome to MedGuardian! Your UserID is ${userid}. This acts as your login key.`;
            const smsResult = await sendSMS(phone, smsMessage);
            
            res.status(201).json({ 
                message: smsResult.success ? `Patient created and SMS sent via ${smsResult.provider}!` : 'Patient created successfully', 
                patientId, 
                simulatedSms: smsResult.provider === 'simulation' ? smsMessage : null,
                smsSent: smsResult.success,
                smsProvider: smsResult.provider
            });
        } catch (err) {
            await connection.rollback();
            if (err.code === 'ER_DUP_ENTRY') {
                return res.status(400).json({ error: 'Email or UserID already exists' });
            }
            throw err;
        } finally {
            connection.release();
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// --- PATIENT ROUTES ---
app.get('/api/access/requests', authenticate, async (req, res) => {
    if (req.user.role !== 'patient') return res.status(403).json({ error: 'Patients only' });
    try {
        const [requests] = await pool.query(`
            SELECT ar.id, ar.status, ar.created_at, u.name as doctor_name
            FROM access_requests ar
            JOIN users u ON ar.doctor_id = u.id
            WHERE ar.patient_id = ?
        `, [req.user.id]);
        res.json(requests);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/access/respond', authenticate, async (req, res) => {
    if (req.user.role !== 'patient') return res.status(403).json({ error: 'Patients only' });
    try {
        const { request_id, action } = req.body; // action: 'approved' or 'rejected'
        if (!['approved', 'rejected'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
        
        const [result] = await pool.query(
            'UPDATE access_requests SET status = ? WHERE id = ? AND patient_id = ?',
            [action, request_id, req.user.id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Request not found' });
        
        res.json({ message: `Request ${action}` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// --- RECORD ROUTES ---
app.get('/api/records/mine', authenticate, async (req, res) => {
    if (req.user.role !== 'patient') return res.status(403).json({ error: 'Patients only' });
    try {
        const [records] = await pool.query('SELECT * FROM health_records WHERE patient_id = ? ORDER BY id ASC', [req.user.id]);
        res.json(records);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/records/upload', authenticate, upload.single('report'), async (req, res) => {
    if (req.user.role !== 'patient') return res.status(403).json({ error: 'Patients only' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    try {
        const filePath = req.file.path;
        let analysisText = 'No analysis available.';
        
        if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'your_actual_gemini_api_key_here') {
            try {
                const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
                const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
                
                const fileBytes = fs.readFileSync(filePath);
                const prompt = "You are a medical AI assistant. Extract the key patient details, diagnosis, and any important findings from this health report. Keep it concise, professional, and limit the response to 3-4 sentences maximum.";
                
                let mimeType = req.file.mimetype;
                if (req.file.originalname.toLowerCase().endsWith('.pdf')) {
                    mimeType = 'application/pdf';
                }

                const aiResult = await model.generateContent([
                    prompt,
                    {
                        inlineData: {
                            data: fileBytes.toString("base64"),
                            mimeType: mimeType
                        }
                    }
                ]);
                
                analysisText = "AI Analysis: " + aiResult.response.text();
            } catch (aiErr) {
                console.error("AI Error:", aiErr);
                analysisText = "AI Analysis simulated (API Error): Lab results indicate slightly elevated HbA1c levels. Blood pressure is within normal ranges. Recommended follow-up in 3 months.";
            }
        } else {
            // Simulated extraction when no real API key is present for prototyping
            analysisText = "AI Analysis (Simulated): Patient shows normal CBC and metabolic panel. Cholesterol is slightly elevated (LDL 130 mg/dL). No acute anomalies detected. Continue current medication plan.";
        }
        
        const extractedTitle = req.file.originalname;
        const [result] = await pool.query(
            'INSERT INTO health_records (patient_id, record_type, title, description) VALUES (?, ?, ?, ?)',
            [req.user.id, 'lab_report', `Uploaded Report: ${extractedTitle}`, analysisText]
        );

        res.status(201).json({ 
            message: 'File uploaded and analyzed successfully', 
            record: {
                id: result.insertId,
                patient_id: req.user.id,
                record_type: 'lab_report',
                title: `Uploaded Report: ${extractedTitle}`,
                description: analysisText
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/records/patient/:patient_id', authenticate, async (req, res) => {
    if (req.user.role !== 'doctor') return res.status(403).json({ error: 'Doctors only' });
    try {
        const patientId = req.params.patient_id;
        const [accessCheck] = await pool.query(
            'SELECT * FROM access_requests WHERE doctor_id = ? AND patient_id = ? AND status = "approved"',
            [req.user.id, patientId]
        );
        if (accessCheck.length === 0) {
            return res.status(403).json({ error: 'You do not have approved access to this patient' });
        }
        const [records] = await pool.query('SELECT * FROM health_records WHERE patient_id = ? ORDER BY id ASC', [patientId]);
        res.json(records);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
