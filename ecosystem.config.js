module.exports = {
  apps: [
    {
      name: "zodibot",
      script: "./index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "300M",
      min_uptime: "10s",
      max_restarts: 20,
      restart_delay: 1000,
      time: true,
      env: {
        NODE_ENV: "production",
        ZODI_UI: "0",
        OPENAI_API_KEY: process.env.OPENAI_API_KEY || ""
      }
    }
  ]
};
