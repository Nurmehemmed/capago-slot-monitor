module.exports = {
  apps: [
    {
      name: 'capago-slot-monitor',
      script: 'dist/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        HEADLESS: 'true',
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
      },
    },
  ],
};
