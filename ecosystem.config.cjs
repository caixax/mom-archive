// pm2 process file. Run with: pnpm pm2:start
module.exports = {
  apps: [
    {
      name: 'momarchive-backend',
      cwd: __dirname + '/backend',
      script: 'dist/main.js',
      interpreter: 'node',
      // ../.env resolves against cwd (backend/), so this reads the repo root .env
      node_args: '--enable-source-maps --env-file-if-exists=../.env',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      kill_timeout: 30000,
      wait_ready: true,
      listen_timeout: 60000,
      max_memory_restart: '4G',
      env: {
        NODE_ENV: 'production',
      },
      // pm2 writes its own log files; the app also writes rotating JSON logs under backend/logs.
      out_file: __dirname + '/logs/pm2-out.log',
      error_file: __dirname + '/logs/pm2-err.log',
      merge_logs: true,
      time: false,
    },
  ],
};
