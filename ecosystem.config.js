// ecosystem.config.js — alternative to Docker for VPS users.
//
// Usage on a fresh Ubuntu/Debian box:
//   sudo apt install -y nodejs npm
//   sudo npm install -g pm2
//   cd /opt/draftix && npm ci --omit=dev
//   pm2 start ecosystem.config.js --env production
//   pm2 save
//   pm2 startup    # follow printed command so pm2 auto-starts on reboot
//
// You still need a reverse proxy (Caddy/nginx) in front of this for TLS.

module.exports = {
  apps: [
    {
      name: "draftix",
      script: "server.js",
      instances: 1,                  // Stateful Socket.io → keep single instance
      exec_mode: "fork",             // (cluster mode would need a sticky session adapter)
      max_memory_restart: "300M",
      kill_timeout: 5000,            // matches our graceful-shutdown grace period
      wait_ready: false,
      listen_timeout: 8000,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",
        PORT: "3000",
        TRUST_PROXY: "1",
        ALLOWED_ORIGINS: "https://draftix.tech,https://www.draftix.tech",
        APP_VERSION: "1.0.0",
      },
      env_production: {
        NODE_ENV: "production",
      },
      out_file: "./data/pm2-out.log",
      error_file: "./data/pm2-err.log",
      merge_logs: true,
      time: true,
    },
  ],
};
