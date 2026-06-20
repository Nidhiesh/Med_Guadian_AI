const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
require('dotenv').config();
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
const crypto = require('crypto');

// On Vercel, the filesystem is read-only. Only create the uploads dir locally.
const IS_VERCEL = process.env.VERCEL === '1';
const uploadDir = path.join(__dirname, 'uploads');
if (!IS_VERCEL) {
    try {
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
    } catch (e) {
        console.warn('Could not create uploads directory:', e.message);
    }
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

// Initialize MySQL pool using environment variables.
// Set DB_HOST, DB_USER, DB_PASSWORD, DB_NAME in your Vercel project settings.
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'medguardian_db',
    port: process.env.DB_PORT ? parseInt(process.env.DB_PORT) : 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined
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

// --- CRYPTO AUTH ROUTES (PASSWORDLESS) ---

// Helper function for Audit Logging
async function logAudit(userId, action, ip, deviceInfo) {
    try {
        await pool.query(
            'INSERT INTO audit_logs (user_id, action, ip_address, device_info) VALUES (?, ?, ?, ?)',
            [userId, action, ip, deviceInfo]
        );
    } catch (e) {
        console.error('Audit log failed:', e);
    }
}

// 1. Device Registration Flow (Setup)
app.post('/api/auth/crypto/:role/register', async (req, res) => {
    try {
        const role = req.params.role;
        const { email, publicKey, deviceName } = req.body;
        if (!email || !publicKey) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        if (role !== 'doctor' && role !== 'admin') {
            return res.status(400).json({ error: 'Invalid role for cryptographic registration' });
        }

        const connection = await pool.getConnection();
        await connection.beginTransaction();

        try {
            // Find existing user (created by Admin)
            const [users] = await connection.query('SELECT id FROM users WHERE email = ? AND role = ?', [email, role]);
            if (users.length === 0) {
                 await connection.rollback();
                 return res.status(404).json({ error: 'Account not found. Please contact an administrator.' });
            }
            const userId = users[0].id;

            // Ensure no existing active keys
            const [existingKeys] = await connection.query('SELECT id FROM user_crypto_credentials WHERE user_id = ? AND is_active = TRUE', [userId]);
            if (existingKeys.length > 0) {
                 await connection.rollback();
                 return res.status(403).json({ error: 'A device is already registered for this account.' });
            }

            // Store public key
            await connection.query(
                'INSERT INTO user_crypto_credentials (user_id, role, public_key, key_algorithm, device_name) VALUES (?, ?, ?, ?, ?)',
                [userId, role, publicKey, 'ECDSA', deviceName || 'Unknown Browser']
            );

            await connection.commit();
            await logAudit(userId, 'Device Registration', req.ip, req.headers['user-agent']);

            res.status(201).json({ message: 'Device securely registered.', id: userId });
        } catch (err) {
            await connection.rollback();
            throw err;
        } finally {
            connection.release();
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// 2. Request Challenge (Login Step 1)
app.post('/api/auth/crypto/:role/challenge', async (req, res) => {
    try {
        const role = req.params.role;
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email required' });

        if (role !== 'doctor' && role !== 'admin') return res.status(400).json({ error: 'Invalid role' });

        const [users] = await pool.query('SELECT id, role FROM users WHERE email = ? AND role = ?', [email, role]);
        if (users.length === 0) return res.status(404).json({ error: 'Account not found. Please contact an administrator.' });
        const user = users[0];

        // CHECK IF DEVICE SETUP IS REQUIRED
        const [creds] = await pool.query('SELECT id FROM user_crypto_credentials WHERE user_id = ? AND is_active = TRUE', [user.id]);
        if (creds.length === 0) {
            return res.status(403).json({ error: 'Device not registered. Setting up secure key...', requiresSetup: true });
        }

        // Generate 32-byte cryptographically secure random nonce
        const nonce = crypto.randomBytes(32).toString('base64');
        const expiresAt = new Date(Date.now() + 60 * 1000); // 60 seconds expiry

        await pool.query(
            'INSERT INTO auth_challenges (user_id, challenge_nonce, expires_at) VALUES (?, ?, ?)',
            [user.id, nonce, expiresAt]
        );

        res.json({ challenge: nonce });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// 3. Verify Signature (Login Step 2)
app.post('/api/auth/crypto/:role/verify', async (req, res) => {
    try {
        const role = req.params.role;
        const { email, signature, clientDataJSON } = req.body;
        if (!email || !signature || !clientDataJSON) return res.status(400).json({ error: 'Missing required fields' });

        if (role !== 'doctor' && role !== 'admin') return res.status(400).json({ error: 'Invalid role' });

        // Parse clientDataJSON to get the challenge
        let clientData;
        try {
            clientData = JSON.parse(Buffer.from(clientDataJSON, 'base64').toString('utf8'));
        } catch (e) {
            return res.status(400).json({ error: 'Invalid clientDataJSON' });
        }
        const returnedChallenge = clientData.challenge;

        // Fetch User
        const [users] = await pool.query('SELECT id, name, role, email FROM users WHERE email = ? AND role = ?', [email, role]);
        if (users.length === 0) return res.status(404).json({ error: 'User not found' });
        const user = users[0];

        // Fetch valid challenge (replay protection & expiry check)
        const [challenges] = await pool.query(
            'SELECT id FROM auth_challenges WHERE user_id = ? AND challenge_nonce = ? AND expires_at > NOW()',
            [user.id, returnedChallenge]
        );
        if (challenges.length === 0) {
            await logAudit(user.id, 'Login Failure - Expired/Invalid Challenge', req.ip, req.headers['user-agent']);
            return res.status(401).json({ error: 'Invalid or expired challenge' });
        }

        // Delete challenge so it can't be reused (One-time use)
        await pool.query('DELETE FROM auth_challenges WHERE id = ?', [challenges[0].id]);

        // Fetch Public Key
        const [creds] = await pool.query('SELECT public_key, id FROM user_crypto_credentials WHERE user_id = ? AND is_active = TRUE', [user.id]);
        if (creds.length === 0) {
            await logAudit(user.id, 'Login Failure - No Active Device', req.ip, req.headers['user-agent']);
            return res.status(401).json({ error: 'No registered cryptographic identity found on this device.' });
        }

        const publicKeyPem = creds[0].public_key;

        // Verify Signature using ieee-p1363 format (Web Crypto default for ECDSA)
        const isValid = crypto.verify(
            'SHA256',
            Buffer.from(clientDataJSON, 'base64'),
            { key: publicKeyPem, dsaEncoding: 'ieee-p1363' },
            Buffer.from(signature, 'base64')
        );

        if (!isValid) {
            await logAudit(user.id, 'Login Failure - Invalid Signature', req.ip, req.headers['user-agent']);
            return res.status(401).json({ error: 'Invalid cryptographic signature' });
        }

        // Update last used
        await pool.query('UPDATE user_crypto_credentials SET last_used_at = NOW() WHERE id = ?', [creds[0].id]);
        await logAudit(user.id, 'Login Success', req.ip, req.headers['user-agent']);

        // Issue JWT
        const token = jwt.sign({ id: user.id, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ message: 'Cryptographic authentication successful.', token, user: { id: user.id, name: user.name, role: user.role, email: user.email } });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Patient Login (unchanged)
app.post('/api/auth/login', async (req, res) => {
    try {
        const { userid } = req.body;
        if (!userid) return res.status(400).json({ error: 'UserID required' });

        const [rows] = await pool.query('SELECT * FROM users WHERE userid = ? AND role = "patient"', [userid]);
        if (rows.length === 0) return res.status(401).json({ error: 'Invalid UserID' });
        
        const user = rows[0];
        const token = jwt.sign({ id: user.id, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '24h' });
        return res.json({ token, user: { id: user.id, name: user.name, role: user.role, email: user.email, userid: user.userid } });
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

app.post('/api/records/upload', authenticate, async (req, res, next) => {
    // Vercel has a read-only filesystem — file uploads are disabled in production.
    // To enable uploads, deploy on a self-hosted server or use a cloud storage provider (e.g. Cloudinary).
    if (IS_VERCEL) {
        return res.status(503).json({
            error: 'File uploads are not supported in the cloud deployment. Please use the locally hosted version to upload reports.'
        });
    }
    // Only process upload middleware locally
    upload.single('report')(req, res, async (uploadErr) => {
        if (uploadErr) return res.status(400).json({ error: uploadErr.message });
        if (!req.user || req.user.role !== 'patient') return res.status(403).json({ error: 'Patients only' });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        try {
            const filePath = req.file.path;
            let analysisText = 'No analysis available.';

            if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'your_actual_gemini_api_key_here') {
                try {
                    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
                    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

                    const fileBytes = fs.readFileSync(filePath);
                    const prompt = 'You are a medical AI assistant. Extract the key patient details, diagnosis, and any important findings from this health report. Keep it concise, professional, and limit the response to 3-4 sentences maximum.';

                    let mimeType = req.file.mimetype;
                    if (req.file.originalname.toLowerCase().endsWith('.pdf')) {
                        mimeType = 'application/pdf';
                    }

                    const aiResult = await model.generateContent([
                        prompt,
                        { inlineData: { data: fileBytes.toString('base64'), mimeType } }
                    ]);
                    analysisText = 'AI Analysis: ' + aiResult.response.text();
                } catch (aiErr) {
                    console.error('AI Error:', aiErr);
                    analysisText = 'AI Analysis simulated (API Error): Lab results indicate slightly elevated HbA1c levels. Blood pressure is within normal ranges. Recommended follow-up in 3 months.';
                }
            } else {
                analysisText = 'AI Analysis (Simulated): Patient shows normal CBC and metabolic panel. Cholesterol is slightly elevated (LDL 130 mg/dL). No acute anomalies detected. Continue current medication plan.';
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
});

app.get('/api/records/patient/:patient_id', authenticate, async (req, res) => {
    if (req.user.role !== 'doctor') return res.status(403).json({ error: 'Doctors only' });
    try {
        const patientId = req.params.patient_id;
        const [records] = await pool.query('SELECT * FROM health_records WHERE patient_id = ? ORDER BY id ASC', [patientId]);
        res.json(records);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// --- ADMIN ROUTES ---
app.get('/api/admin/directory', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
    try {
        // Fetch all doctors
        const [doctors] = await pool.query('SELECT id, name, email, hospital FROM users WHERE role = "doctor" ORDER BY name ASC');
        
        // Fetch all patients assigned to doctors
        const [patients] = await pool.query(`
            SELECT u.id, u.name, u.email, u.hospital, ar.doctor_id 
            FROM users u
            JOIN access_requests ar ON u.id = ar.patient_id
            WHERE u.role = "patient" AND ar.status = "approved"
        `);
        
        // Group patients by doctor
        const directory = doctors.map(doc => {
            return {
                ...doc,
                patients: patients.filter(p => p.doctor_id === doc.id)
            };
        });
        
        res.json(directory);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Create Doctor Endpoint
app.post('/api/admin/create-doctor', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
    try {
        const { name, email, hospital } = req.body;
        if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
        
        await pool.query(
            'INSERT INTO users (name, email, password_hash, role, hospital) VALUES (?, ?, NULL, "doctor", ?)',
            [name, email, hospital || 'Independent']
        );
        res.status(201).json({ message: 'Doctor account created successfully. They can now log in to set up their device key.' });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Email already exists' });
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Delete Doctor Endpoint
app.delete('/api/admin/delete-doctor/:id', authenticate, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
    try {
        const doctorId = req.params.id;

        // Verify target is a doctor (can't delete patients or admins this way)
        const [rows] = await pool.query('SELECT id, name FROM users WHERE id = ? AND role = "doctor"', [doctorId]);
        if (rows.length === 0) return res.status(404).json({ error: 'Doctor not found' });

        // Remove crypto credentials first (FK constraint)
        await pool.query('DELETE FROM user_crypto_credentials WHERE user_id = ?', [doctorId]);
        // Remove auth challenges
        await pool.query('DELETE FROM auth_challenges WHERE user_id = ?', [doctorId]);
        // Remove the user
        await pool.query('DELETE FROM users WHERE id = ?', [doctorId]);

        await logAudit(req.user.id, `Deleted Doctor Account: ${rows[0].name} (ID ${doctorId})`, req.ip, req.headers['user-agent']);
        res.json({ message: `Doctor account for ${rows[0].name} has been removed.` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Database initialization: Seed Admin
async function seedAdmin() {
    try {
        const [rows] = await pool.query('SELECT id FROM users WHERE email = ?', ['admin@gmail.com']);
        if (rows.length === 0) {
            await pool.query('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, NULL, ?)', ['Admin', 'admin@gmail.com', 'admin']);
            console.log('Seeded initial admin account (admin@gmail.com)');
        }
    } catch (err) {
        console.error('Failed to seed admin:', err);
    }
}
seedAdmin();

// Export the Express app for Vercel serverless functions.
// When running locally with `node server.js`, this also starts the server.
if (process.env.VERCEL !== '1') {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;
