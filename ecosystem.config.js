module.exports = {
  apps : [
      {
        name: "sqp-data-node-backend",
        script: "/var/www/html/sqp-data-node-backend/src/server.js",
        watch: true,
		error_file: '/var/www/html/sqp-data-node-backend/pm2/error.log',
        out_file: '/var/www/html/sqp-data-node-backend/pm2/output.log',
        log_file: '/var/www/html/sqp-data-node-backend/pm2/combined.log',
        ignore_watch: [
			"/var/www/html/sqp-data-node-backend/logs/*", 
			"/var/www/html/sqp-data-node-backend/node_modules/*", 
			"/var/www/html/sqp-data-node-backend/db/*",
			"/var/www/html/sqp-data-node-backend/pm2/*"
		], 
		exec_mode: "cluster",
		instances: 2,
		env_file: ".env",
        env: {
          "PORT": 4212,
          "NODE_ENV": "local"
        },
        env_development: {
          "PORT": 4212,
          "NODE_ENV": "development",
        },
        env_staging: {
          "PORT": 4212,
          "NODE_ENV": "staging",
        },
        env_production: {
          "PORT": 4212,
          "NODE_ENV": "production",
        }
      }
  ]
}
