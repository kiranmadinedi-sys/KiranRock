# Email OTP Setup Guide

## Gmail Configuration for OTP Service

To enable email verification, you need to configure Gmail credentials:

### Step 1: Create App Password

1. Go to your Google Account: https://myaccount.google.com/
2. Navigate to **Security** → **2-Step Verification** (enable if not already)
3. Scroll down to **App passwords**
4. Click **Select app** → Choose "Mail"
5. Click **Select device** → Choose "Other (Custom name)"
6. Enter "KiranRock Trading" and click **Generate**
7. Copy the 16-character password

### Step 2: Set Environment Variables

**Option 1: Add to start.ps1 (Recommended)**

Already configured in your start script! Just update these values:

```powershell
$env:EMAIL_USER = "your-email@gmail.com"
$env:EMAIL_PASSWORD = "your-app-password-here"
```

**Option 2: Manual Configuration**

Set environment variables before starting:

```powershell
$env:EMAIL_USER = "your-email@gmail.com"
$env:EMAIL_PASSWORD = "xxxx xxxx xxxx xxxx"  # 16-char app password
```

### Step 3: Test the Setup

1. Start the application: `.\start.ps1`
2. Go to http://localhost:3000/login
3. Click "Sign Up" tab
4. Fill in the form and submit
5. Check your email for the 6-digit verification code

## Features

### Signup Process
1. **User fills signup form** with:
   - Username (required)
   - Email (required)
   - Password (required)
   - First Name, Last Name (optional)
   - Phone (optional)

2. **System sends OTP** to email
   - 6-digit verification code
   - Expires in 10 minutes
   - Professional email template

3. **User verifies email** by entering the 6-digit code

4. **Account created** and user is logged in automatically

### Security Features
- ✅ Email validation
- ✅ Password confirmation check
- ✅ OTP expiration (10 minutes)
- ✅ Signup session expiration (30 minutes)
- ✅ Duplicate username/email prevention
- ✅ Automatic cleanup of expired OTPs

### Email Template
Beautiful HTML email with:
- Professional branding
- Large, easy-to-read OTP
- Expiration notice
- Modern design

## Existing Users

**Important:** Existing user profiles are NOT affected!

- All existing users can continue logging in normally
- No changes to existing user data
- New fields (email, firstName, lastName) are optional for existing users
- Old login method still works exactly the same

## Troubleshooting

### Email not sending?
- Check Gmail App Password is correct
- Verify 2-Step Verification is enabled
- Make sure environment variables are set
- Check backend console for [OTP] logs

### "Invalid or expired verification code"?
- OTP expires after 10 minutes
- Request a new code by signing up again
- Check you entered all 6 digits correctly

### "Email already registered"?
- Use a different email address
- Or log in with existing credentials

## Production Recommendations

For production deployment:

1. **Use a dedicated email service** like:
   - SendGrid
   - Amazon SES
   - Mailgun
   - Twilio SendGrid

2. **Store OTPs in Redis** instead of memory

3. **Hash passwords** before storing (use bcrypt)

4. **Add rate limiting** to prevent abuse

5. **Implement "Resend Code" feature**

6. **Add CAPTCHA** to prevent bot signups

## Configuration Files

### Backend
- `src/services/otpService.js` - OTP generation and sending
- `src/controllers/authController.js` - Signup endpoints
- `src/routes/authRoutes.js` - API routes
- `src/services/userService.js` - User management

### Frontend
- `app/login/page.tsx` - Login/Signup UI

## API Endpoints

### POST /api/auth/signup
Request:
```json
{
  "username": "johndoe",
  "email": "john@example.com",
  "password": "securepass123",
  "firstName": "John",
  "lastName": "Doe",
  "phone": "1234567890"
}
```

Response:
```json
{
  "message": "Verification code sent to your email",
  "email": "john@example.com"
}
```

### POST /api/auth/verify-signup
Request:
```json
{
  "email": "john@example.com",
  "otp": "123456"
}
```

Response:
```json
{
  "token": "jwt-token-here",
  "message": "Account created successfully"
}
```

## Next Steps

1. Configure your Gmail credentials
2. Update start.ps1 with your email settings
3. Test the signup flow
4. Customize email template if needed (otpService.js)
5. Add additional validation rules as needed

Enjoy your new signup system! 🎉
