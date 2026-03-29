const express = require('express');
const mysql = require('mysql');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Resend } = require('resend');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// ================= DB CONNECTION =================
const connection = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

connection.connect((err) => {
    if (err) {
        console.error('Database connection failed:', err);
        return;
    }
    console.log('MySQL Connected...');
});

// ================= MIDDLEWARE =================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ================= RESEND SETUP =================
const resend = new Resend(process.env.RESEND_API_KEY);

// ================= MAKE SURE UPLOAD FOLDERS EXIST =================
const uploadsDir = path.join(__dirname, 'uploads');
const profileDir = path.join(uploadsDir, 'profile');
const locationsDir = path.join(uploadsDir, 'locations');

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });
if (!fs.existsSync(locationsDir)) fs.mkdirSync(locationsDir, { recursive: true });

// ================= FILE STORAGE =================
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (file.fieldname === 'profile_image') {
            cb(null, profileDir);
        } else if (file.fieldname === 'image') {
            cb(null, locationsDir);
        } else {
            cb(null, uploadsDir);
        }
    },
    filename: (req, file, cb) => {
        const uniqueName =
            Date.now() +
            '-' +
            Math.round(Math.random() * 1e9) +
            path.extname(file.originalname);
        cb(null, uniqueName);
    }
});

const upload = multer({ storage });

// ================= HELPER FUNCTIONS =================
const generateToken = () => crypto.randomBytes(32).toString('hex');

const isLocalUploadPath = (filePath) => {
    return typeof filePath === 'string' && filePath.startsWith('uploads/');
};

const deleteLocalFileIfExists = (relativePath) => {
    try {
        if (!isLocalUploadPath(relativePath)) return;
        const absolutePath = path.join(__dirname, relativePath);
        if (fs.existsSync(absolutePath)) {
            fs.unlinkSync(absolutePath);
        }
    } catch (error) {
        console.error('Failed to delete file:', error.message);
    }
};

const buildStaticMapUrl = (latitude, longitude) => {
    const key = process.env.MAPQUEST_KEY;
    return `https://www.mapquestapi.com/staticmap/v5/map?key=${key}&center=${latitude},${longitude}&size=700,400@2x&zoom=14&locations=${latitude},${longitude}|marker-red`;
};

const downloadStaticMapImage = async (latitude, longitude) => {
    if (!process.env.MAPQUEST_KEY) {
        throw new Error('MAPQUEST_KEY is missing in backend .env');
    }

    const imageUrl = buildStaticMapUrl(latitude, longitude);
    const response = await fetch(imageUrl);

    if (!response.ok) {
        throw new Error(`Failed to download static map image: ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const filename = `map-${Date.now()}-${Math.round(Math.random() * 1e9)}.png`;
    const absolutePath = path.join(locationsDir, filename);

    fs.writeFileSync(absolutePath, buffer);

    return `uploads/locations/${filename}`;
};

const sendVerificationEmail = async (email, token) => {
    const verifyLink = `${process.env.CLIENT_URL}/verify-email?token=${token}`;

    await resend.emails.send({
        from: 'onboarding@resend.dev',
        to: email,
        subject: 'Verify Your Account',
        html: `
            <h2>Email Verification</h2>
            <p>Click the link below to verify your account:</p>
            <a href="${verifyLink}">${verifyLink}</a>
        `
    });
};

const sendResetEmail = async (email, token) => {
    const resetLink = `${process.env.CLIENT_URL}/reset-password?token=${token}`;

    await resend.emails.send({
        from: 'onboarding@resend.dev',
        to: email,
        subject: 'Reset Your Password',
        html: `
            <h2>Reset Password</h2>
            <p>Click the link below to reset your password:</p>
            <a href="${resetLink}">${resetLink}</a>
        `
    });
};

const verifyJWT = (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Access denied. No token provided.' });
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(401).json({ message: 'Invalid or expired token.' });
    }
};

// ================= TEST ROUTES =================
app.get('/', (req, res) => {
    res.send('GIS Backend API is running...');
});

app.get('/api/test-db', (req, res) => {
    connection.query('SELECT 1 AS test', (err, result) => {
        if (err) {
            return res.status(500).json({ success: false, error: err });
        }
        res.json({ success: true, result });
    });
});

app.get('/api/test-email', async (req, res) => {
    try {
        await resend.emails.send({
            from: 'onboarding@resend.dev',
            to: 'example@email.com',
            subject: 'Test Email from Resend',
            html: '<h2>Hello</h2><p>Your Resend setup is working.</p>'
        });

        res.json({ success: true, message: 'Test email sent successfully' });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            success: false,
            message: 'Failed to send test email',
            error
        });
    }
});

// ================= AUTH =================

// REGISTER
app.post('/api/register', upload.single('profile_image'), async (req, res) => {
    try {
        const { username, email, password, fullname } = req.body;

        if (!username || !email || !password || !fullname) {
            return res.status(400).json({ message: 'All fields are required.' });
        }

        const checkSql = 'SELECT * FROM users WHERE username = ? OR email = ?';
        connection.query(checkSql, [username, email], async (err, existingUsers) => {
            if (err) return res.status(500).json(err);

            if (existingUsers.length > 0) {
                return res.status(400).json({ message: 'Username or email already exists.' });
            }

            const hashedPassword = await bcrypt.hash(password, 10);
            const profileImage = req.file ? `uploads/profile/${req.file.filename}` : null;

            const insertUserSql = `
                INSERT INTO users (username, email, password_hash, fullname, profile_image, is_verified)
                VALUES (?, ?, ?, ?, ?, 0)
            `;

            connection.query(
                insertUserSql,
                [username, email, hashedPassword, fullname, profileImage],
                async (err2, result) => {
                    if (err2) return res.status(500).json(err2);

                    const userId = result.insertId;
                    const token = generateToken();
                    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

                    const insertTokenSql = `
                        INSERT INTO email_verification_tokens (user_id, token, expires_at)
                        VALUES (?, ?, ?)
                    `;

                    connection.query(insertTokenSql, [userId, token, expiresAt], async (err3) => {
                        if (err3) return res.status(500).json(err3);

                        try {
                            await sendVerificationEmail(email, token);
                            res.json({
                                success: true,
                                message: 'Registration successful. Please check your email to verify your account.'
                            });
                        } catch (emailError) {
                            console.error(emailError);
                            res.status(500).json({
                                success: false,
                                message: 'User created but verification email failed to send.',
                                error: emailError
                            });
                        }
                    });
                }
            );
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Registration failed.', error });
    }
});

// VERIFY EMAIL
app.get('/api/verify-email', (req, res) => {
    const { token } = req.query;

    if (!token) {
        return res.status(400).json({ message: 'Verification token is required.' });
    }

    const sql = `
        SELECT * FROM email_verification_tokens
        WHERE token = ? AND used_at IS NULL AND expires_at > NOW()
    `;

    connection.query(sql, [token], (err, result) => {
        if (err) return res.status(500).json(err);

        if (result.length === 0) {
            return res.status(400).json({ message: 'Invalid or expired verification token.' });
        }

        const userId = result[0].user_id;
        const verifyId = result[0].verify_id;

        connection.query(
            'UPDATE users SET is_verified = 1 WHERE user_id = ?',
            [userId],
            (err2) => {
                if (err2) return res.status(500).json(err2);

                connection.query(
                    'UPDATE email_verification_tokens SET used_at = NOW() WHERE verify_id = ?',
                    [verifyId],
                    (err3) => {
                        if (err3) return res.status(500).json(err3);

                        res.json({
                            success: true,
                            message: 'Email verified successfully. You can now log in.'
                        });
                    }
                );
            }
        );
    });
});

// LOGIN
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ message: 'Email and password are required.' });
    }

    const sql = 'SELECT * FROM users WHERE email = ?';
    connection.query(sql, [email], async (err, result) => {
        if (err) return res.status(500).json(err);

        if (result.length === 0) {
            return res.status(401).json({ message: 'Invalid email or password.' });
        }

        const user = result[0];
        const isMatch = await bcrypt.compare(password, user.password_hash);

        if (!isMatch) {
            return res.status(401).json({ message: 'Invalid email or password.' });
        }

        if (user.is_verified !== 1) {
            return res.status(403).json({ message: 'Please verify your email before logging in.' });
        }

        const token = jwt.sign(
            {
                user_id: user.user_id,
                username: user.username,
                email: user.email
            },
            process.env.JWT_SECRET,
            { expiresIn: '1d' }
        );

        res.json({
            success: true,
            message: 'Login successful',
            token,
            user: {
                user_id: user.user_id,
                username: user.username,
                email: user.email,
                fullname: user.fullname,
                profile_image: user.profile_image,
                is_verified: user.is_verified
            }
        });
    });
});

// LOGOUT
app.post('/api/logout', (req, res) => {
    res.json({
        success: true,
        message: 'Logout successful. Remove token on the frontend.'
    });
});

// FORGOT PASSWORD
app.post('/api/forgot-password', (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ message: 'Email is required.' });
    }

    const findUserSql = 'SELECT * FROM users WHERE email = ?';
    connection.query(findUserSql, [email], (err, users) => {
        if (err) return res.status(500).json(err);

        if (users.length === 0) {
            return res.status(404).json({ message: 'Email not found.' });
        }

        const user = users[0];
        const token = generateToken();
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

        const insertResetSql = `
            INSERT INTO password_reset_tokens (user_id, token, expires_at)
            VALUES (?, ?, ?)
        `;

        connection.query(insertResetSql, [user.user_id, token, expiresAt], async (err2) => {
            if (err2) return res.status(500).json(err2);

            try {
                await sendResetEmail(email, token);
                res.json({
                    success: true,
                    message: 'Password reset link has been sent to your email.'
                });
            } catch (emailError) {
                console.error(emailError);
                res.status(500).json({
                    success: false,
                    message: 'Failed to send reset email.',
                    error: emailError
                });
            }
        });
    });
});

// RESET PASSWORD
app.post('/api/reset-password', async (req, res) => {
    try {
        const { token, new_password } = req.body;

        if (!token || !new_password) {
            return res.status(400).json({ message: 'Token and new password are required.' });
        }

        const sql = `
            SELECT * FROM password_reset_tokens
            WHERE token = ? AND used_at IS NULL AND expires_at > NOW()
        `;

        connection.query(sql, [token], async (err, result) => {
            if (err) return res.status(500).json(err);

            if (result.length === 0) {
                return res.status(400).json({ message: 'Invalid or expired reset token.' });
            }

            const resetRow = result[0];
            const hashedPassword = await bcrypt.hash(new_password, 10);

            connection.query(
                'UPDATE users SET password_hash = ? WHERE user_id = ?',
                [hashedPassword, resetRow.user_id],
                (err2) => {
                    if (err2) return res.status(500).json(err2);

                    connection.query(
                        'UPDATE password_reset_tokens SET used_at = NOW() WHERE reset_id = ?',
                        [resetRow.reset_id],
                        (err3) => {
                            if (err3) return res.status(500).json(err3);

                            res.json({
                                success: true,
                                message: 'Password has been reset successfully.'
                            });
                        }
                    );
                }
            );
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Reset password failed.', error });
    }
});

// ================= PROFILE =================

// GET MY PROFILE
app.get('/api/profile', verifyJWT, (req, res) => {
    const sql = `
        SELECT user_id, username, email, fullname, profile_image, is_verified, created_at, updated_at
        FROM users
        WHERE user_id = ?
    `;

    connection.query(sql, [req.user.user_id], (err, result) => {
        if (err) return res.status(500).json(err);

        if (result.length === 0) {
            return res.status(404).json({ message: 'User not found.' });
        }

        res.json(result[0]);
    });
});

// UPDATE PROFILE
app.put('/api/profile', verifyJWT, upload.single('profile_image'), (req, res) => {
    const { username, email, fullname } = req.body;

    const getUserSql = 'SELECT * FROM users WHERE user_id = ?';
    connection.query(getUserSql, [req.user.user_id], (err, users) => {
        if (err) return res.status(500).json(err);
        if (users.length === 0) return res.status(404).json({ message: 'User not found.' });

        const currentUser = users[0];
        const oldProfileImage = currentUser.profile_image;
        const profileImage = req.file ? `uploads/profile/${req.file.filename}` : currentUser.profile_image;

        const updateSql = `
            UPDATE users
            SET username = ?, email = ?, fullname = ?, profile_image = ?
            WHERE user_id = ?
        `;

        connection.query(
            updateSql,
            [
                username || currentUser.username,
                email || currentUser.email,
                fullname || currentUser.fullname,
                profileImage,
                req.user.user_id
            ],
            (err2) => {
                if (err2) return res.status(500).json(err2);

                if (req.file && oldProfileImage && oldProfileImage !== profileImage) {
                    deleteLocalFileIfExists(oldProfileImage);
                }

                res.json({
                    success: true,
                    message: 'Profile updated successfully.'
                });
            }
        );
    });
});

// ================= LOCATIONS =================

// CREATE LOCATION
app.post('/api/locations', verifyJWT, upload.single('image'), async (req, res) => {
    try {
        const {
            location,
            description,
            latitude,
            longitude,
            city,
            province,
            source_type
        } = req.body;

        if (!location || !latitude || !longitude) {
            return res.status(400).json({ message: 'Location, latitude, and longitude are required.' });
        }

        let imagePath = null;

        if (req.file) {
            imagePath = `uploads/locations/${req.file.filename}`;
        } else {
            imagePath = await downloadStaticMapImage(latitude, longitude);
        }

        const sql = `
            INSERT INTO locations (
                user_id, location, description,
                latitude, longitude, city, province,
                image_path, source_type
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        connection.query(
            sql,
            [
                req.user.user_id,
                location,
                description || null,
                latitude,
                longitude,
                city || null,
                province || null,
                imagePath,
                source_type || (req.file ? 'manual' : 'generated')
            ],
            (err) => {
                if (err) {
                    console.error('INSERT LOCATION SQL ERROR:', err);
                    return res.status(500).json({
                        success: false,
                        message: 'Failed to insert location.',
                        error: err.message
                    });
                }

                res.json({
                    success: true,
                    message: req.file
                        ? 'Location added successfully with uploaded image.'
                        : 'Location added successfully with auto-generated map image.'
                });
            }
        );
    } catch (error) {
        console.error('Create location error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to add location.',
            error: error.message
        });
    }
});

// GET ALL LOCATIONS
app.get('/api/locations', (req, res) => {
    const sql = `
        SELECT
            l.*,
            u.username,
            u.fullname
        FROM locations l
        JOIN users u ON l.user_id = u.user_id
        ORDER BY l.location_id DESC
    `;

    connection.query(sql, (err, result) => {
        if (err) {
            console.error('GET LOCATIONS SQL ERROR:', err);
            return res.status(500).json({
                success: false,
                message: 'Failed to fetch locations.',
                error: err.message
            });
        }

        res.json(result);
    });
});

// GET ONE LOCATION
app.get('/api/locations/:id', (req, res) => {
    const sql = `
        SELECT
            l.*,
            u.username,
            u.fullname
        FROM locations l
        JOIN users u ON l.user_id = u.user_id
        WHERE l.location_id = ?
    `;

    connection.query(sql, [req.params.id], (err, result) => {
        if (err) {
            console.error('GET ONE LOCATION SQL ERROR:', err);
            return res.status(500).json({
                success: false,
                message: 'Failed to fetch location.',
                error: err.message
            });
        }

        if (result.length === 0) {
            return res.status(404).json({ message: 'Location not found.' });
        }

        res.json(result[0]);
    });
});

// UPDATE LOCATION
app.put('/api/locations/:id', verifyJWT, upload.single('image'), async (req, res) => {
    try {
        const {
            location,
            description,
            latitude,
            longitude,
            city,
            province,
            source_type
        } = req.body;

        const locationId = req.params.id;
        const getSql = 'SELECT * FROM locations WHERE location_id = ?';

        connection.query(getSql, [locationId], async (err, rows) => {
            if (err) {
                console.error('GET LOCATION BEFORE UPDATE ERROR:', err);
                return res.status(500).json({
                    success: false,
                    message: 'Failed to fetch location before update.',
                    error: err.message
                });
            }

            if (rows.length === 0) {
                return res.status(404).json({ message: 'Location not found.' });
            }

            const existing = rows[0];

            if (existing.user_id !== req.user.user_id) {
                return res.status(403).json({ message: 'You are not allowed to update this location.' });
            }

            let imagePath = existing.image_path;
            const oldImagePath = existing.image_path;

            if (req.file) {
                imagePath = `uploads/locations/${req.file.filename}`;
                if (oldImagePath && oldImagePath !== imagePath) {
                    deleteLocalFileIfExists(oldImagePath);
                }
            } else if (!existing.image_path && (latitude || existing.latitude) && (longitude || existing.longitude)) {
                imagePath = await downloadStaticMapImage(
                    latitude || existing.latitude,
                    longitude || existing.longitude
                );
            }

            const updateSql = `
                UPDATE locations
                SET
                    location = ?,
                    description = ?,
                    latitude = ?,
                    longitude = ?,
                    city = ?,
                    province = ?,
                    image_path = ?,
                    source_type = ?
                WHERE location_id = ?
            `;

            connection.query(
                updateSql,
                [
                    location || existing.location,
                    description !== undefined ? description : existing.description,
                    latitude || existing.latitude,
                    longitude || existing.longitude,
                    city !== undefined ? city : existing.city,
                    province !== undefined ? province : existing.province,
                    imagePath,
                    source_type || existing.source_type,
                    locationId
                ],
                (err2) => {
                    if (err2) {
                        console.error('UPDATE LOCATION SQL ERROR:', err2);
                        return res.status(500).json({
                            success: false,
                            message: 'Failed to update location.',
                            error: err2.message
                        });
                    }

                    res.json({
                        success: true,
                        message: 'Location updated successfully.'
                    });
                }
            );
        });
    } catch (error) {
        console.error('Update location error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update location.',
            error: error.message
        });
    }
});

// DELETE LOCATION
app.delete('/api/locations/:id', verifyJWT, (req, res) => {
    const locationId = req.params.id;
    const getSql = 'SELECT * FROM locations WHERE location_id = ?';

    connection.query(getSql, [locationId], (err, rows) => {
        if (err) {
            console.error('GET LOCATION BEFORE DELETE ERROR:', err);
            return res.status(500).json({
                success: false,
                message: 'Failed to fetch location before delete.',
                error: err.message
            });
        }

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Location not found.' });
        }

        const existing = rows[0];

        if (existing.user_id !== req.user.user_id) {
            return res.status(403).json({ message: 'You are not allowed to delete this location.' });
        }

        const oldImagePath = existing.image_path;
        const deleteSql = 'DELETE FROM locations WHERE location_id = ?';

        connection.query(deleteSql, [locationId], (err2) => {
            if (err2) {
                console.error('DELETE LOCATION SQL ERROR:', err2);
                return res.status(500).json({
                    success: false,
                    message: 'Failed to delete location.',
                    error: err2.message
                });
            }

            if (oldImagePath) {
                deleteLocalFileIfExists(oldImagePath);
            }

            res.json({
                success: true,
                message: 'Location deleted successfully.'
            });
        });
    });
});

// ================= START SERVER =================
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});



//---------------------------PRODUCTION---------------------------------------------------//
// const express = require('express');
// const mysql = require('mysql');
// const cors = require('cors');
// const bcrypt = require('bcryptjs');
// const jwt = require('jsonwebtoken');
// const multer = require('multer');
// const path = require('path');
// const fs = require('fs');
// const crypto = require('crypto');
// const { Resend } = require('resend');
// require('dotenv').config();

// const app = express();
// const PORT = process.env.PORT || 5000;

// // ================= DB CONNECTION =================
// const connection = mysql.createConnection({
//     host: process.env.DB_HOST,
//     user: process.env.DB_USER,
//     password: process.env.DB_PASSWORD,
//     database: process.env.DB_NAME
// });

// connection.connect((err) => {
//     if (err) {
//         console.error('Database connection failed:', err);
//         return;
//     }
//     console.log('MySQL Connected...');
// });

// // ================= PATHS =================
// const uploadsDir = path.join(__dirname, 'uploads');
// const profileDir = path.join(uploadsDir, 'profile');
// const locationsDir = path.join(uploadsDir, 'locations');
// const frontendDistPath = path.join(__dirname, 'gis-frontend', 'dist');

// // ================= MIDDLEWARE =================
// // Production + local friendly CORS
// const allowedOrigins = [
//     process.env.CLIENT_URL,
//     process.env.CLIENT_URL_LOCAL,
//     process.env.FRONTEND_URL
// ].filter(Boolean);

// app.use(
//     cors({
//         origin: (origin, callback) => {
//             // Allow requests like Postman, curl, same-server, or server-to-server
//             if (!origin) return callback(null, true);

//             if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
//                 return callback(null, true);
//             }

//             return callback(new Error('Not allowed by CORS'));
//         },
//         credentials: true
//     })
// );

// app.use(express.json());
// app.use(express.urlencoded({ extended: true }));
// app.use('/uploads', express.static(uploadsDir));

// // ================= RESEND SETUP =================
// const resend = new Resend(process.env.RESEND_API_KEY);

// // ================= MAKE SURE UPLOAD FOLDERS EXIST =================
// if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
// if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });
// if (!fs.existsSync(locationsDir)) fs.mkdirSync(locationsDir, { recursive: true });

// // ================= FILE STORAGE =================
// const storage = multer.diskStorage({
//     destination: (req, file, cb) => {
//         if (file.fieldname === 'profile_image') {
//             cb(null, profileDir);
//         } else if (file.fieldname === 'image') {
//             cb(null, locationsDir);
//         } else {
//             cb(null, uploadsDir);
//         }
//     },
//     filename: (req, file, cb) => {
//         const uniqueName =
//             Date.now() +
//             '-' +
//             Math.round(Math.random() * 1e9) +
//             path.extname(file.originalname);
//         cb(null, uniqueName);
//     }
// });

// const upload = multer({ storage });

// // ================= HELPER FUNCTIONS =================
// const generateToken = () => crypto.randomBytes(32).toString('hex');

// const isLocalUploadPath = (filePath) => {
//     return typeof filePath === 'string' && filePath.startsWith('uploads/');
// };

// const deleteLocalFileIfExists = (relativePath) => {
//     try {
//         if (!isLocalUploadPath(relativePath)) return;
//         const absolutePath = path.join(__dirname, relativePath);
//         if (fs.existsSync(absolutePath)) {
//             fs.unlinkSync(absolutePath);
//         }
//     } catch (error) {
//         console.error('Failed to delete file:', error.message);
//     }
// };

// const buildStaticMapUrl = (latitude, longitude) => {
//     const key = process.env.MAPQUEST_KEY;
//     return `https://www.mapquestapi.com/staticmap/v5/map?key=${key}&center=${latitude},${longitude}&size=700,400@2x&zoom=14&locations=${latitude},${longitude}|marker-red`;
// };

// const downloadStaticMapImage = async (latitude, longitude) => {
//     if (!process.env.MAPQUEST_KEY) {
//         throw new Error('MAPQUEST_KEY is missing in backend .env');
//     }

//     const imageUrl = buildStaticMapUrl(latitude, longitude);
//     const response = await fetch(imageUrl);

//     if (!response.ok) {
//         throw new Error(`Failed to download static map image: ${response.status} ${response.statusText}`);
//     }

//     const arrayBuffer = await response.arrayBuffer();
//     const buffer = Buffer.from(arrayBuffer);

//     const filename = `map-${Date.now()}-${Math.round(Math.random() * 1e9)}.png`;
//     const absolutePath = path.join(locationsDir, filename);

//     fs.writeFileSync(absolutePath, buffer);

//     return `uploads/locations/${filename}`;
// };

// const sendVerificationEmail = async (email, token) => {
//     const verifyLink = `${process.env.CLIENT_URL}/verify-email?token=${token}`;

//     await resend.emails.send({
//         from: 'onboarding@resend.dev',
//         to: email,
//         subject: 'Verify Your Account',
//         html: `
//             <h2>Email Verification</h2>
//             <p>Click the link below to verify your account:</p>
//             <a href="${verifyLink}">${verifyLink}</a>
//         `
//     });
// };

// const sendResetEmail = async (email, token) => {
//     const resetLink = `${process.env.CLIENT_URL}/reset-password?token=${token}`;

//     await resend.emails.send({
//         from: 'onboarding@resend.dev',
//         to: email,
//         subject: 'Reset Your Password',
//         html: `
//             <h2>Reset Password</h2>
//             <p>Click the link below to reset your password:</p>
//             <a href="${resetLink}">${resetLink}</a>
//         `
//     });
// };

// const verifyJWT = (req, res, next) => {
//     const authHeader = req.headers.authorization;

//     if (!authHeader || !authHeader.startsWith('Bearer ')) {
//         return res.status(401).json({ message: 'Access denied. No token provided.' });
//     }

//     const token = authHeader.split(' ')[1];

//     try {
//         const decoded = jwt.verify(token, process.env.JWT_SECRET);
//         req.user = decoded;
//         next();
//     } catch (error) {
//         return res.status(401).json({ message: 'Invalid or expired token.' });
//     }
// };

// // ================= TEST ROUTES =================
// app.get('/api/health', (req, res) => {
//     res.json({
//         success: true,
//         message: 'GIS Backend API is running...'
//     });
// });

// app.get('/api/test-db', (req, res) => {
//     connection.query('SELECT 1 AS test', (err, result) => {
//         if (err) {
//             return res.status(500).json({ success: false, error: err });
//         }
//         res.json({ success: true, result });
//     });
// });

// app.get('/api/test-email', async (req, res) => {
//     try {
//         await resend.emails.send({
//             from: 'onboarding@resend.dev',
//             to: 'example@email.com',
//             subject: 'Test Email from Resend',
//             html: '<h2>Hello</h2><p>Your Resend setup is working.</p>'
//         });

//         res.json({ success: true, message: 'Test email sent successfully' });
//     } catch (error) {
//         console.error(error);
//         res.status(500).json({
//             success: false,
//             message: 'Failed to send test email',
//             error
//         });
//     }
// });

// // ================= AUTH =================

// // REGISTER
// app.post('/api/register', upload.single('profile_image'), async (req, res) => {
//     try {
//         const { username, email, password, fullname } = req.body;

//         if (!username || !email || !password || !fullname) {
//             return res.status(400).json({ message: 'All fields are required.' });
//         }

//         const checkSql = 'SELECT * FROM users WHERE username = ? OR email = ?';
//         connection.query(checkSql, [username, email], async (err, existingUsers) => {
//             if (err) return res.status(500).json(err);

//             if (existingUsers.length > 0) {
//                 return res.status(400).json({ message: 'Username or email already exists.' });
//             }

//             const hashedPassword = await bcrypt.hash(password, 10);
//             const profileImage = req.file ? `uploads/profile/${req.file.filename}` : null;

//             const insertUserSql = `
//                 INSERT INTO users (username, email, password_hash, fullname, profile_image, is_verified)
//                 VALUES (?, ?, ?, ?, ?, 0)
//             `;

//             connection.query(
//                 insertUserSql,
//                 [username, email, hashedPassword, fullname, profileImage],
//                 async (err2, result) => {
//                     if (err2) return res.status(500).json(err2);

//                     const userId = result.insertId;
//                     const token = generateToken();
//                     const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

//                     const insertTokenSql = `
//                         INSERT INTO email_verification_tokens (user_id, token, expires_at)
//                         VALUES (?, ?, ?)
//                     `;

//                     connection.query(insertTokenSql, [userId, token, expiresAt], async (err3) => {
//                         if (err3) return res.status(500).json(err3);

//                         try {
//                             await sendVerificationEmail(email, token);
//                             res.json({
//                                 success: true,
//                                 message: 'Registration successful. Please check your email to verify your account.'
//                             });
//                         } catch (emailError) {
//                             console.error(emailError);
//                             res.status(500).json({
//                                 success: false,
//                                 message: 'User created but verification email failed to send.',
//                                 error: emailError
//                             });
//                         }
//                     });
//                 }
//             );
//         });
//     } catch (error) {
//         console.error(error);
//         res.status(500).json({ message: 'Registration failed.', error });
//     }
// });

// // VERIFY EMAIL
// app.get('/api/verify-email', (req, res) => {
//     const { token } = req.query;

//     if (!token) {
//         return res.status(400).json({ message: 'Verification token is required.' });
//     }

//     const sql = `
//         SELECT * FROM email_verification_tokens
//         WHERE token = ? AND used_at IS NULL AND expires_at > NOW()
//     `;

//     connection.query(sql, [token], (err, result) => {
//         if (err) return res.status(500).json(err);

//         if (result.length === 0) {
//             return res.status(400).json({ message: 'Invalid or expired verification token.' });
//         }

//         const userId = result[0].user_id;
//         const verifyId = result[0].verify_id;

//         connection.query(
//             'UPDATE users SET is_verified = 1 WHERE user_id = ?',
//             [userId],
//             (err2) => {
//                 if (err2) return res.status(500).json(err2);

//                 connection.query(
//                     'UPDATE email_verification_tokens SET used_at = NOW() WHERE verify_id = ?',
//                     [verifyId],
//                     (err3) => {
//                         if (err3) return res.status(500).json(err3);

//                         res.json({
//                             success: true,
//                             message: 'Email verified successfully. You can now log in.'
//                         });
//                     }
//                 );
//             }
//         );
//     });
// });

// // LOGIN
// app.post('/api/login', (req, res) => {
//     const { email, password } = req.body;

//     if (!email || !password) {
//         return res.status(400).json({ message: 'Email and password are required.' });
//     }

//     const sql = 'SELECT * FROM users WHERE email = ?';
//     connection.query(sql, [email], async (err, result) => {
//         if (err) return res.status(500).json(err);

//         if (result.length === 0) {
//             return res.status(401).json({ message: 'Invalid email or password.' });
//         }

//         const user = result[0];
//         const isMatch = await bcrypt.compare(password, user.password_hash);

//         if (!isMatch) {
//             return res.status(401).json({ message: 'Invalid email or password.' });
//         }

//         if (user.is_verified !== 1) {
//             return res.status(403).json({ message: 'Please verify your email before logging in.' });
//         }

//         const token = jwt.sign(
//             {
//                 user_id: user.user_id,
//                 username: user.username,
//                 email: user.email
//             },
//             process.env.JWT_SECRET,
//             { expiresIn: '1d' }
//         );

//         res.json({
//             success: true,
//             message: 'Login successful',
//             token,
//             user: {
//                 user_id: user.user_id,
//                 username: user.username,
//                 email: user.email,
//                 fullname: user.fullname,
//                 profile_image: user.profile_image,
//                 is_verified: user.is_verified
//             }
//         });
//     });
// });

// // LOGOUT
// app.post('/api/logout', (req, res) => {
//     res.json({
//         success: true,
//         message: 'Logout successful. Remove token on the frontend.'
//     });
// });

// // FORGOT PASSWORD
// app.post('/api/forgot-password', (req, res) => {
//     const { email } = req.body;

//     if (!email) {
//         return res.status(400).json({ message: 'Email is required.' });
//     }

//     const findUserSql = 'SELECT * FROM users WHERE email = ?';
//     connection.query(findUserSql, [email], (err, users) => {
//         if (err) return res.status(500).json(err);

//         if (users.length === 0) {
//             return res.status(404).json({ message: 'Email not found.' });
//         }

//         const user = users[0];
//         const token = generateToken();
//         const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

//         const insertResetSql = `
//             INSERT INTO password_reset_tokens (user_id, token, expires_at)
//             VALUES (?, ?, ?)
//         `;

//         connection.query(insertResetSql, [user.user_id, token, expiresAt], async (err2) => {
//             if (err2) return res.status(500).json(err2);

//             try {
//                 await sendResetEmail(email, token);
//                 res.json({
//                     success: true,
//                     message: 'Password reset link has been sent to your email.'
//                 });
//             } catch (emailError) {
//                 console.error(emailError);
//                 res.status(500).json({
//                     success: false,
//                     message: 'Failed to send reset email.',
//                     error: emailError
//                 });
//             }
//         });
//     });
// });

// // RESET PASSWORD
// app.post('/api/reset-password', async (req, res) => {
//     try {
//         const { token, new_password } = req.body;

//         if (!token || !new_password) {
//             return res.status(400).json({ message: 'Token and new password are required.' });
//         }

//         const sql = `
//             SELECT * FROM password_reset_tokens
//             WHERE token = ? AND used_at IS NULL AND expires_at > NOW()
//         `;

//         connection.query(sql, [token], async (err, result) => {
//             if (err) return res.status(500).json(err);

//             if (result.length === 0) {
//                 return res.status(400).json({ message: 'Invalid or expired reset token.' });
//             }

//             const resetRow = result[0];
//             const hashedPassword = await bcrypt.hash(new_password, 10);

//             connection.query(
//                 'UPDATE users SET password_hash = ? WHERE user_id = ?',
//                 [hashedPassword, resetRow.user_id],
//                 (err2) => {
//                     if (err2) return res.status(500).json(err2);

//                     connection.query(
//                         'UPDATE password_reset_tokens SET used_at = NOW() WHERE reset_id = ?',
//                         [resetRow.reset_id],
//                         (err3) => {
//                             if (err3) return res.status(500).json(err3);

//                             res.json({
//                                 success: true,
//                                 message: 'Password has been reset successfully.'
//                             });
//                         }
//                     );
//                 }
//             );
//         });
//     } catch (error) {
//         console.error(error);
//         res.status(500).json({ message: 'Reset password failed.', error });
//     }
// });

// // ================= PROFILE =================

// // GET MY PROFILE
// app.get('/api/profile', verifyJWT, (req, res) => {
//     const sql = `
//         SELECT user_id, username, email, fullname, profile_image, is_verified, created_at, updated_at
//         FROM users
//         WHERE user_id = ?
//     `;

//     connection.query(sql, [req.user.user_id], (err, result) => {
//         if (err) return res.status(500).json(err);

//         if (result.length === 0) {
//             return res.status(404).json({ message: 'User not found.' });
//         }

//         res.json(result[0]);
//     });
// });

// // UPDATE PROFILE
// app.put('/api/profile', verifyJWT, upload.single('profile_image'), (req, res) => {
//     const { username, email, fullname } = req.body;

//     const getUserSql = 'SELECT * FROM users WHERE user_id = ?';
//     connection.query(getUserSql, [req.user.user_id], (err, users) => {
//         if (err) return res.status(500).json(err);
//         if (users.length === 0) return res.status(404).json({ message: 'User not found.' });

//         const currentUser = users[0];
//         const oldProfileImage = currentUser.profile_image;
//         const profileImage = req.file ? `uploads/profile/${req.file.filename}` : currentUser.profile_image;

//         const updateSql = `
//             UPDATE users
//             SET username = ?, email = ?, fullname = ?, profile_image = ?
//             WHERE user_id = ?
//         `;

//         connection.query(
//             updateSql,
//             [
//                 username || currentUser.username,
//                 email || currentUser.email,
//                 fullname || currentUser.fullname,
//                 profileImage,
//                 req.user.user_id
//             ],
//             (err2) => {
//                 if (err2) return res.status(500).json(err2);

//                 if (req.file && oldProfileImage && oldProfileImage !== profileImage) {
//                     deleteLocalFileIfExists(oldProfileImage);
//                 }

//                 res.json({
//                     success: true,
//                     message: 'Profile updated successfully.'
//                 });
//             }
//         );
//     });
// });

// // ================= LOCATIONS =================

// // CREATE LOCATION
// app.post('/api/locations', verifyJWT, upload.single('image'), async (req, res) => {
//     try {
//         const {
//             location,
//             description,
//             latitude,
//             longitude,
//             city,
//             province,
//             source_type
//         } = req.body;

//         if (!location || !latitude || !longitude) {
//             return res.status(400).json({ message: 'Location, latitude, and longitude are required.' });
//         }

//         let imagePath = null;

//         if (req.file) {
//             imagePath = `uploads/locations/${req.file.filename}`;
//         } else {
//             imagePath = await downloadStaticMapImage(latitude, longitude);
//         }

//         const sql = `
//             INSERT INTO locations (
//                 user_id, location, description,
//                 latitude, longitude, city, province,
//                 image_path, source_type
//             )
//             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
//         `;

//         connection.query(
//             sql,
//             [
//                 req.user.user_id,
//                 location,
//                 description || null,
//                 latitude,
//                 longitude,
//                 city || null,
//                 province || null,
//                 imagePath,
//                 source_type || (req.file ? 'manual' : 'generated')
//             ],
//             (err) => {
//                 if (err) {
//                     console.error('INSERT LOCATION SQL ERROR:', err);
//                     return res.status(500).json({
//                         success: false,
//                         message: 'Failed to insert location.',
//                         error: err.message
//                     });
//                 }

//                 res.json({
//                     success: true,
//                     message: req.file
//                         ? 'Location added successfully with uploaded image.'
//                         : 'Location added successfully with auto-generated map image.'
//                 });
//             }
//         );
//     } catch (error) {
//         console.error('Create location error:', error);
//         res.status(500).json({
//             success: false,
//             message: 'Failed to add location.',
//             error: error.message
//         });
//     }
// });

// // GET ALL LOCATIONS
// app.get('/api/locations', (req, res) => {
//     const sql = `
//         SELECT
//             l.*,
//             u.username,
//             u.fullname
//         FROM locations l
//         JOIN users u ON l.user_id = u.user_id
//         ORDER BY l.location_id DESC
//     `;

//     connection.query(sql, (err, result) => {
//         if (err) {
//             console.error('GET LOCATIONS SQL ERROR:', err);
//             return res.status(500).json({
//                 success: false,
//                 message: 'Failed to fetch locations.',
//                 error: err.message
//             });
//         }

//         res.json(result);
//     });
// });

// // GET ONE LOCATION
// app.get('/api/locations/:id', (req, res) => {
//     const sql = `
//         SELECT
//             l.*,
//             u.username,
//             u.fullname
//         FROM locations l
//         JOIN users u ON l.user_id = u.user_id
//         WHERE l.location_id = ?
//     `;

//     connection.query(sql, [req.params.id], (err, result) => {
//         if (err) {
//             console.error('GET ONE LOCATION SQL ERROR:', err);
//             return res.status(500).json({
//                 success: false,
//                 message: 'Failed to fetch location.',
//                 error: err.message
//             });
//         }

//         if (result.length === 0) {
//             return res.status(404).json({ message: 'Location not found.' });
//         }

//         res.json(result[0]);
//     });
// });

// // UPDATE LOCATION
// app.put('/api/locations/:id', verifyJWT, upload.single('image'), async (req, res) => {
//     try {
//         const {
//             location,
//             description,
//             latitude,
//             longitude,
//             city,
//             province,
//             source_type
//         } = req.body;

//         const locationId = req.params.id;
//         const getSql = 'SELECT * FROM locations WHERE location_id = ?';

//         connection.query(getSql, [locationId], async (err, rows) => {
//             if (err) {
//                 console.error('GET LOCATION BEFORE UPDATE ERROR:', err);
//                 return res.status(500).json({
//                     success: false,
//                     message: 'Failed to fetch location before update.',
//                     error: err.message
//                 });
//             }

//             if (rows.length === 0) {
//                 return res.status(404).json({ message: 'Location not found.' });
//             }

//             const existing = rows[0];

//             if (existing.user_id !== req.user.user_id) {
//                 return res.status(403).json({ message: 'You are not allowed to update this location.' });
//             }

//             let imagePath = existing.image_path;
//             const oldImagePath = existing.image_path;

//             if (req.file) {
//                 imagePath = `uploads/locations/${req.file.filename}`;
//                 if (oldImagePath && oldImagePath !== imagePath) {
//                     deleteLocalFileIfExists(oldImagePath);
//                 }
//             } else if (!existing.image_path && (latitude || existing.latitude) && (longitude || existing.longitude)) {
//                 imagePath = await downloadStaticMapImage(
//                     latitude || existing.latitude,
//                     longitude || existing.longitude
//                 );
//             }

//             const updateSql = `
//                 UPDATE locations
//                 SET
//                     location = ?,
//                     description = ?,
//                     latitude = ?,
//                     longitude = ?,
//                     city = ?,
//                     province = ?,
//                     image_path = ?,
//                     source_type = ?
//                 WHERE location_id = ?
//             `;

//             connection.query(
//                 updateSql,
//                 [
//                     location || existing.location,
//                     description !== undefined ? description : existing.description,
//                     latitude || existing.latitude,
//                     longitude || existing.longitude,
//                     city !== undefined ? city : existing.city,
//                     province !== undefined ? province : existing.province,
//                     imagePath,
//                     source_type || existing.source_type,
//                     locationId
//                 ],
//                 (err2) => {
//                     if (err2) {
//                         console.error('UPDATE LOCATION SQL ERROR:', err2);
//                         return res.status(500).json({
//                             success: false,
//                             message: 'Failed to update location.',
//                             error: err2.message
//                         });
//                     }

//                     res.json({
//                         success: true,
//                         message: 'Location updated successfully.'
//                     });
//                 }
//             );
//         });
//     } catch (error) {
//         console.error('Update location error:', error);
//         res.status(500).json({
//             success: false,
//             message: 'Failed to update location.',
//             error: error.message
//         });
//     }
// });

// // DELETE LOCATION
// app.delete('/api/locations/:id', verifyJWT, (req, res) => {
//     const locationId = req.params.id;
//     const getSql = 'SELECT * FROM locations WHERE location_id = ?';

//     connection.query(getSql, [locationId], (err, rows) => {
//         if (err) {
//             console.error('GET LOCATION BEFORE DELETE ERROR:', err);
//             return res.status(500).json({
//                 success: false,
//                 message: 'Failed to fetch location before delete.',
//                 error: err.message
//             });
//         }

//         if (rows.length === 0) {
//             return res.status(404).json({ message: 'Location not found.' });
//         }

//         const existing = rows[0];

//         if (existing.user_id !== req.user.user_id) {
//             return res.status(403).json({ message: 'You are not allowed to delete this location.' });
//         }

//         const oldImagePath = existing.image_path;
//         const deleteSql = 'DELETE FROM locations WHERE location_id = ?';

//         connection.query(deleteSql, [locationId], (err2) => {
//             if (err2) {
//                 console.error('DELETE LOCATION SQL ERROR:', err2);
//                 return res.status(500).json({
//                     success: false,
//                     message: 'Failed to delete location.',
//                     error: err2.message
//                 });
//             }

//             if (oldImagePath) {
//                 deleteLocalFileIfExists(oldImagePath);
//             }

//             res.json({
//                 success: true,
//                 message: 'Location deleted successfully.'
//             });
//         });
//     });
// });

// // ================= API 404 =================
// app.use('/api', (req, res) => {
//     res.status(404).json({
//         success: false,
//         message: 'API route not found.'
//     });
// });

// // ================= SERVE REACT FRONTEND (PRODUCTION) =================
// if (fs.existsSync(frontendDistPath)) {
//     app.use(express.static(frontendDistPath));

//     app.get('*', (req, res, next) => {
//         if (req.originalUrl.startsWith('/api')) {
//             return next();
//         }

//         res.sendFile(path.join(frontendDistPath, 'index.html'));
//     });
// } else {
//     app.get('/', (req, res) => {
//         res.send('GIS Backend API is running...');
//     });
// }

// // ================= GLOBAL ERROR HANDLER =================
// app.use((err, req, res, next) => {
//     console.error('Unhandled server error:', err);

//     if (err.message === 'Not allowed by CORS') {
//         return res.status(403).json({
//             success: false,
//             message: err.message
//         });
//     }

//     res.status(500).json({
//         success: false,
//         message: 'Internal server error.'
//     });
// });

// // ================= START SERVER =================
// app.listen(PORT, '0.0.0.0', () => {
//     console.log(`Server running on port ${PORT}`);
// });