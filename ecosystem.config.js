module.exports = {
  apps : [
      {
        name: "qb-poc-backend",
        script: "/var/www/html/qb-backend/index.js",
        watch: false,
	error_file: '/var/www/html/qb-backend/pm2/error.log',
        out_file: '/var/www/html/qb-backend/pm2/output.log',
        log_file: '/var/www/html/qb-backend/pm2/combined.log',
        ignore_watch: ["/var/www/html/qb-backend/log/*", "/var/www/html/qb-backend/node_modules/*", "/var/www/html/qb-backend/db/*"], 
        env: {
          "PORT": 4112,
          "NODE_ENV": "local"
        },
        env_development: {
          "PORT": 4112,
          "NODE_ENV": "development",
        },
        env_staging: {
          "PORT": 4112,
          "NODE_ENV": "staging",
        },
        env_production: {
          "PORT": 4112,
          "NODE_ENV": "production",
        }
      }
  ]
}
