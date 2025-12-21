const nodemailer = require('nodemailer');
const crypto = require('crypto');

// Store OTPs temporarily (in production, use Redis or database)
const otpStore = new Map();

// Email transporter configuration
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER || 'your-email@gmail.com',
        pass: process.env.EMAIL_PASSWORD || 'your-app-password'
    }
});

/**
 * Generate a 6-digit OTP
 */
function generateOTP() {
    return crypto.randomInt(100000, 999999).toString();
}

/**
 * Send OTP to email
 * @param {string} email - User's email address
 * @param {string} username - Username for personalization
 * @returns {Promise<string>} - The generated OTP
 */
async function sendOTP(email, username) {
    const otp = generateOTP();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    // Store OTP with expiration
    otpStore.set(email, { otp, expiresAt, username });

    const mailOptions = {
        from: process.env.EMAIL_USER || 'KiranRock Trading Platform',
        to: email,
        subject: '🔐 Your Verification Code - KiranRock Trading',
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f4f4f4;">
                <div style="background-color: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
                    <h1 style="color: #2563eb; text-align: center; margin-bottom: 20px;">
                        📊 KiranRock Trading Platform
                    </h1>
                    <h2 style="color: #333; margin-bottom: 20px;">Welcome, ${username}!</h2>
                    <p style="color: #666; font-size: 16px; line-height: 1.5;">
                        Thank you for signing up. To complete your registration, please use the verification code below:
                    </p>
                    <div style="background-color: #f0f7ff; border: 2px dashed #2563eb; border-radius: 8px; padding: 20px; text-align: center; margin: 30px 0;">
                        <p style="color: #666; margin: 0 0 10px 0; font-size: 14px;">Your Verification Code</p>
                        <h1 style="color: #2563eb; font-size: 48px; letter-spacing: 8px; margin: 10px 0; font-family: 'Courier New', monospace;">
                            ${otp}
                        </h1>
                    </div>
                    <p style="color: #999; font-size: 14px; text-align: center; margin-top: 20px;">
                        ⏰ This code will expire in 10 minutes
                    </p>
                    <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
                    <p style="color: #999; font-size: 12px; text-align: center;">
                        If you didn't request this code, please ignore this email.
                    </p>
                    <p style="color: #999; font-size: 12px; text-align: center; margin-top: 10px;">
                        © ${new Date().getFullYear()} KiranRock Trading Platform. All rights reserved.
                    </p>
                </div>
            </div>
        `
    };

    try {
        // Check if email is configured
        if (!process.env.EMAIL_USER || process.env.EMAIL_USER === 'your-email@gmail.com') {
            console.log(`[OTP] ⚠️  Email not configured. OTP for ${username} (${email}): ${otp}`);
            console.log(`[OTP] 🔐 Use this code to verify: ${otp}`);
            return otp;
        }

        await transporter.sendMail(mailOptions);
        console.log(`[OTP] Sent to ${email} for user ${username}`);
        return otp;
    } catch (error) {
        console.error('[OTP] Error sending email:', error);
        // Fallback: Log OTP to console for testing
        console.log(`[OTP] ⚠️  Email failed. OTP for ${username} (${email}): ${otp}`);
        console.log(`[OTP] 🔐 Use this code to verify: ${otp}`);
        return otp;
    }
}

/**
 * Verify OTP
 * @param {string} email - User's email address
 * @param {string} otp - OTP to verify
 * @returns {boolean} - True if valid, false otherwise
 */
function verifyOTP(email, otp) {
    const stored = otpStore.get(email);
    
    if (!stored) {
        console.log(`[OTP] No OTP found for ${email}`);
        return false;
    }

    if (Date.now() > stored.expiresAt) {
        console.log(`[OTP] Expired OTP for ${email}`);
        otpStore.delete(email);
        return false;
    }

    if (stored.otp !== otp) {
        console.log(`[OTP] Invalid OTP for ${email}`);
        return false;
    }

    // OTP is valid, remove it
    otpStore.delete(email);
    console.log(`[OTP] Successfully verified for ${email}`);
    return true;
}

/**
 * Clear expired OTPs periodically
 */
setInterval(() => {
    const now = Date.now();
    for (const [email, data] of otpStore.entries()) {
        if (now > data.expiresAt) {
            otpStore.delete(email);
            console.log(`[OTP] Cleaned up expired OTP for ${email}`);
        }
    }
}, 5 * 60 * 1000); // Every 5 minutes

module.exports = {
    sendOTP,
    verifyOTP,
    generateOTP
};
