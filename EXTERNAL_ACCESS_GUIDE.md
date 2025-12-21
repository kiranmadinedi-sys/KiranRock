# External Access Configuration Guide

## ✅ Configuration Complete

Your KiranRock Trading Platform is now configured to accept external connections from the internet.

## What Was Changed

### 1. Backend CORS Configuration (`backend/src/app.js`)
- Added support for public IP: `http://99.47.183.33:3000`
- Allowed all ports on your public IP (99.47.183.33)
- Allowed all ports on your local network IP (192.168.1.206)
- Backend already listening on `0.0.0.0` (all network interfaces)

### 2. Frontend Configuration
- **`frontend/package.json`**: Updated dev and start scripts to listen on `0.0.0.0`
- **`frontend/next.config.js`**: Created new config file with external access headers
- Frontend now accepts connections from any IP address

### 3. Current Status
✅ Backend listening on: `0.0.0.0:3001`
✅ Frontend listening on: `0.0.0.0:3000`
✅ CORS configured for your public IP
✅ Both servers running and ready

## 🔥 Firewall Configuration Required

To allow external users to access your application, you need to open ports in Windows Firewall.

### Run PowerShell as Administrator and execute:

```powershell
# Allow incoming connections on port 3000 (Frontend)
New-NetFirewallRule -DisplayName "KiranRock Trading Frontend (Port 3000)" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow -Profile Any

# Allow incoming connections on port 3001 (Backend API)
New-NetFirewallRule -DisplayName "KiranRock Trading Backend (Port 3001)" -Direction Inbound -LocalPort 3001 -Protocol TCP -Action Allow -Profile Any
```

### Alternative: Using Windows Defender Firewall GUI

1. Open **Windows Defender Firewall with Advanced Security**
2. Click **Inbound Rules** → **New Rule**
3. Select **Port** → Click **Next**
4. Select **TCP** and enter **3000** → Click **Next**
5. Select **Allow the connection** → Click **Next**
6. Check all profiles (Domain, Private, Public) → Click **Next**
7. Name: **KiranRock Trading Frontend** → Click **Finish**
8. Repeat steps 2-7 for port **3001** (name it **KiranRock Trading Backend**)

## 🌐 Access URLs

### From Local Machine
- Frontend: `http://localhost:3000`
- Backend: `http://localhost:3001`

### From Local Network (same WiFi/LAN)
- Frontend: `http://192.168.1.206:3000`
- Backend: `http://192.168.1.206:3001`

### From Internet (External Users)
- Frontend: `http://99.47.183.33:3000`
- Backend: `http://99.47.183.33:3001`

**Login Page**: `http://99.47.183.33:3000/login`

## 📡 Router Configuration (Port Forwarding)

If users from the internet still cannot connect, configure port forwarding in your router:

1. Log into your router (usually `http://192.168.1.1`)
2. Find **Port Forwarding** or **Virtual Server** settings
3. Add two rules:

   **Rule 1: Frontend**
   - External Port: `3000`
   - Internal IP: `192.168.1.206`
   - Internal Port: `3000`
   - Protocol: TCP

   **Rule 2: Backend**
   - External Port: `3001`
   - Internal IP: `192.168.1.206`
   - Internal Port: `3001`
   - Protocol: TCP

4. Save and restart router if needed

## 🔒 Security Considerations

### Current Setup
- ⚠️ HTTP only (not HTTPS) - data transmitted in plain text
- ⚠️ No rate limiting on API endpoints
- ⚠️ JWT tokens expire after 1 hour

### Recommended for Production

1. **Use HTTPS**: Get SSL certificate (Let's Encrypt) and use reverse proxy (nginx)
2. **Add Rate Limiting**: Prevent API abuse
3. **Strong Passwords**: Enforce password policies
4. **Environment Variables**: Never hardcode credentials
5. **Firewall Rules**: Restrict access to specific IPs if possible
6. **Regular Updates**: Keep dependencies updated

## 📝 Configuration Files Modified

1. **backend/src/app.js**
   - Enhanced CORS to allow your public IP
   - Already configured to listen on `0.0.0.0:3001`

2. **frontend/package.json**
   - Changed: `"dev": "next dev -H 0.0.0.0"`
   - Changed: `"start": "next start -H 0.0.0.0"`

3. **frontend/next.config.js** (NEW)
   - Created config for external access
   - Added CORS headers for development

## 🧪 Testing External Access

### From Another Device on Same Network:
```bash
# Test backend
curl http://192.168.1.206:3001/api/auth/login

# Open in browser
http://192.168.1.206:3000/login
```

### From External Internet:
```bash
# Test backend
curl http://99.47.183.33:3001/api/auth/login

# Open in browser
http://99.47.183.33:3000/login
```

## ⚠️ Important Notes

1. **Dynamic IP**: If `99.47.183.33` is a dynamic IP from your ISP, it may change. Consider:
   - Using a Dynamic DNS service (like No-IP, DuckDNS)
   - Updating CORS configuration when IP changes

2. **ISP Restrictions**: Some ISPs block incoming connections on common ports. If external access fails:
   - Check with your ISP
   - Try using different ports (e.g., 8080, 8443)
   - Consider using a VPN or cloud hosting

3. **Backend API Configuration**: 
   - Frontend expects backend at `localhost:3001` by default
   - For external access, you may need to set environment variable:
     ```
     NEXT_PUBLIC_API_BASE_URL=http://99.47.183.33:3001
     ```

## 🚀 Quick Start Commands

### Start Servers (Already Running)
```powershell
cd C:\MyProject\KiranRock
.\start.ps1
```

### Check if Servers are Listening
```powershell
Get-NetTCPConnection -LocalPort 3000,3001 -State Listen | Select-Object LocalAddress, LocalPort, State
```

### View Firewall Rules
```powershell
Get-NetFirewallRule | Where-Object {$_.DisplayName -like "*KiranRock*"}
```

### Test from Local Network
```powershell
# Test backend
Invoke-RestMethod -Uri "http://192.168.1.206:3001/api/auth/login" -Method POST -ContentType "application/json" -Body '{"username":"admin","password":"admin123"}'
```

## 📞 Troubleshooting

### Users Cannot Connect from Internet

1. ✅ **Check Firewall**: Verify ports 3000 and 3001 are allowed
   ```powershell
   Get-NetFirewallRule | Where-Object {$_.LocalPort -eq 3000 -or $_.LocalPort -eq 3001}
   ```

2. ✅ **Check Port Forwarding**: Verify router is forwarding ports to 192.168.1.206

3. ✅ **Check Public IP**: Verify your current public IP
   ```powershell
   Invoke-RestMethod -Uri "https://api.ipify.org?format=json"
   ```

4. ✅ **Test Locally First**: Confirm application works on local network
   ```
   http://192.168.1.206:3000/login
   ```

5. ✅ **Check Server Status**: Ensure both servers are running
   ```powershell
   Get-Process -Name node
   ```

### CORS Errors

If you see CORS errors in browser console:
- The CORS configuration in `backend/src/app.js` is now very permissive
- Check browser console for the exact origin being blocked
- Add that origin to the allowed list if needed

## ✨ Current Configuration Summary

| Component | Listen Address | Port | Status | External Access |
|-----------|---------------|------|--------|-----------------|
| Backend   | 0.0.0.0       | 3001 | ✅ Running | ⚠️ Needs Firewall |
| Frontend  | 0.0.0.0       | 3000 | ✅ Running | ⚠️ Needs Firewall |
| CORS      | Configured    | -    | ✅ Ready   | ✅ Public IP Allowed |

**Next Step**: Run the firewall commands as administrator to complete the setup!
