# Stock Analysis App - Deployment Guide

## External Access Configuration

### 1. Server Configuration

#### Backend Server (Port 3001)
- The server now binds to `0.0.0.0` (all interfaces) by default
- Set `HOST` environment variable if needed: `HOST=0.0.0.0`
- Default port: `3001`

#### Frontend Server (Port 3000)
- Automatically detects hostname for API calls
- Set `NEXT_PUBLIC_API_BASE_URL` for custom API endpoint

### 2. Environment Variables

#### For Production Deployment:
```bash
# Backend
HOST=0.0.0.0
PORT=3001

# Frontend
NEXT_PUBLIC_API_BASE_URL=http://your-server-ip:3001
```

### 3. Network Configuration

#### Port Forwarding (Router)
- Forward port 3000 (frontend) to your server
- Forward port 3001 (backend) to your server

#### Firewall Rules
- Allow incoming connections on ports 3000 and 3001
- Allow outgoing connections for Yahoo Finance API

### 4. CORS Configuration

The backend now allows dynamic origins for port 3000:
- `http://localhost:3000`
- `http://127.0.0.1:3000`
- `http://192.168.1.206:3000`
- `http://99.47.183.33:3000`
- Any origin ending with `:3000`

### 5. Client IP Logging

The backend now logs:
- Client IP address
- Request method and path
- User-Agent
- Timestamp

Example log:
```
[2025-11-08T12:34:56.789Z] GET /api/auth/login - IP: 192.168.1.100 - User-Agent: Mozilla/5.0...
```

### 6. Deployment Commands

#### Start Backend:
```bash
cd backend
HOST=0.0.0.0 npm start
```

#### Start Frontend:
```bash
cd frontend
NEXT_PUBLIC_API_BASE_URL=http://your-server-ip:3001 npm run build
npm start
```

#### Development with external access:
```bash
# Backend
cd backend
HOST=0.0.0.0 npm start

# Frontend (new terminal)
cd frontend
NEXT_PUBLIC_API_BASE_URL=http://your-server-ip:3001 npm run dev
```

### 7. Troubleshooting

#### Issue: "Connection timeout after login"
- Check if backend is accessible from external IP
- Verify CORS configuration
- Check firewall settings
- Ensure ports are forwarded correctly

#### Issue: "API_BASE_URL not working"
- Verify the NEXT_PUBLIC_API_BASE_URL environment variable
- Check if the backend server is running on the specified IP/port
- Test API endpoint directly: `curl http://your-server-ip:3001/api/auth/login`

#### Issue: "CORS errors"
- Add your domain/IP to the CORS allowed origins in `backend/src/app.js`
- Or modify the CORS function to allow your specific origin

### 8. Security Considerations

- Change default JWT secret in production
- Use HTTPS in production
- Implement rate limiting
- Add proper authentication validation
- Monitor logs for suspicious activity