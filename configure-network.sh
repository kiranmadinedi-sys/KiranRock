#!/bin/bash

# Stock Analysis App - Configuration and Testing Script

echo "=== Stock Analysis App - Network Configuration ==="
echo ""

# Get network information
echo "Network Information:"
echo "==================="
hostname -I | awk '{print "Local IPs: " $0}'
echo "External IP: $(curl -s ifconfig.me)"
echo ""

# Check if ports are open
echo "Port Status:"
echo "============="
netstat -tlnp | grep -E ':300[01]' || echo "Ports 3000/3001 not found listening"
echo ""

# Test backend connectivity
echo "Backend API Test:"
echo "=================="
if curl -s http://localhost:3001/api/auth/login > /dev/null; then
    echo "✅ Backend is accessible locally"
else
    echo "❌ Backend is not accessible locally"
fi

# Test external connectivity (if server IP is provided)
if [ ! -z "$1" ]; then
    SERVER_IP=$1
    echo ""
    echo "External Access Test for $SERVER_IP:"
    echo "===================================="
    if curl -s --max-time 10 http://$SERVER_IP:3001/api/auth/login > /dev/null; then
        echo "✅ Backend is accessible externally"
    else
        echo "❌ Backend is not accessible externally"
        echo "   - Check firewall settings"
        echo "   - Verify port forwarding"
        echo "   - Ensure backend is bound to 0.0.0.0"
    fi

    if curl -s --max-time 10 http://$SERVER_IP:3000 > /dev/null; then
        echo "✅ Frontend is accessible externally"
    else
        echo "❌ Frontend is not accessible externally"
        echo "   - Check if frontend is running"
        echo "   - Verify port forwarding for port 3000"
    fi
fi

echo ""
echo "Configuration Tips:"
echo "==================="
echo "1. Set NEXT_PUBLIC_API_BASE_URL=http://$SERVER_IP:3001 in frontend"
echo "2. Ensure backend HOST=0.0.0.0"
echo "3. Forward ports 3000 and 3001 in router"
echo "4. Allow ports in firewall"
echo ""
echo "Usage: $0 [server-ip]"