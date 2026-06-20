const mysql = require('mysql2/promise');

async function alterDb() {
    const pool = mysql.createPool({
        host: 'localhost',
        user: 'root',
        password: '', 
        database: 'medguardian_db',
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
    });

    try {
        console.log('Altering users table...');
        await pool.query('ALTER TABLE users ADD COLUMN phone VARCHAR(20) DEFAULT NULL');
        console.log('Added phone column.');
    } catch (e) {
        console.log('Phone column might already exist:', e.message);
    }

    try {
        await pool.query('ALTER TABLE users ADD COLUMN userid VARCHAR(50) UNIQUE DEFAULT NULL');
        console.log('Added userid column.');
    } catch (e) {
        console.log('Userid column might already exist:', e.message);
    }

    pool.end();
    console.log('Done.');
}

alterDb();
