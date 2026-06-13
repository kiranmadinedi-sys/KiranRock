// API base URL — always use relative paths so requests proxy through Next.js (port 3000).
// This ensures mobile browsers on cellular data (which block port 3001) still work.
export function getApiBaseUrl(): string {
	return '';
}
