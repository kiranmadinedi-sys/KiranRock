/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow external access
  experimental: {
    // Enable external access from any host
  },
  // Server Actions are enabled by default in Next.js 14
  serverActions: {
    allowedOrigins: ['*'],
    bodySizeLimit: '2mb',
  },
  // Suppress origin header warnings
  onDemandEntries: {
    maxInactiveAge: 25 * 1000,
    pagesBufferLength: 2,
  },
  // Disable hostname check for development
  ...(process.env.NODE_ENV === 'development' && {
    // This is needed for Next.js 14 to accept connections from external IPs
    async headers() {
      return [
        {
          source: '/:path*',
          headers: [
            { key: 'Access-Control-Allow-Origin', value: '*' },
            { key: 'Access-Control-Allow-Methods', value: 'GET,POST,PUT,DELETE,OPTIONS' },
            { key: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization' },
            { key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate, max-age=0' },
            { key: 'Pragma', value: 'no-cache' },
            { key: 'Expires', value: '0' },
          ],
        },
      ];
    },
  }),
};

module.exports = nextConfig;
