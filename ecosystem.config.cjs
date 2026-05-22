module.exports = {
  apps: [
    {
      name: 'media-bot',
      script: 'dist/index.js',
      cwd: __dirname,
      node_args: '',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
