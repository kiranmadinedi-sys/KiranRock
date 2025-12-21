// Configurable API base URL for backend
// Dynamically detects if accessing from external IP or localhost
// CACHE BUSTER v2.1 - Force browser reload

// This function MUST be called at runtime (client-side) to detect the hostname
export function getApiBaseUrl(): string {
	// CRITICAL: Only run in browser, never during SSR
	if (typeof window === 'undefined') {
		console.log('⚠️ getApiBaseUrl called during SSR, returning placeholder');
		// Return a placeholder that will be replaced client-side
		return '';
	}

	const hostname = window.location.hostname;
	console.log(`🔥 [CONFIG DEBUG] hostname type: ${typeof hostname}, value: "${hostname}"`);
	console.log(`🔥 [CONFIG DEBUG] comparison result: ${hostname === '99.47.183.33'}`);
	
	// If accessing via external IP, use that IP for backend
	if (hostname === '99.47.183.33' || hostname === '192.168.1.206') {
		console.log(`[CONFIG v2.1] Detected external access: ${hostname}, using backend: http://${hostname}:3001`);
		return `http://${hostname}:3001`;
	}
	
	// For any other IP address (not localhost), use that IP
	if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
		console.log(`[CONFIG v2.1] Detected IP access: ${hostname}, using backend: http://${hostname}:3001`);
		return `http://${hostname}:3001`;
	}
	
	console.log(`[CONFIG] Using localhost backend: http://localhost:3001`);
	return 'http://localhost:3001';
}
