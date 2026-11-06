const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const baseConfig = {
  username: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'drishyamvms',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  dialect: 'mysql',
  logging: false,
  define: {
    timestamps: true,
    underscored: true,
  },
  pool: {
    max: 20,
    min: 5,
    acquire: 30000,
    idle: 10000,
  },
  
};

module.exports = {
  development: {
    ...baseConfig,
    logging: false,  // Disabled SQL query logging for clean error logs
  },
  test: {
    ...baseConfig,
    database: `${baseConfig.database}_test`,
  },
  production: {
    ...baseConfig,
    pool: {
      max: 50,
      min: 10,
      acquire: 60000,
      idle: 10000,
    },
    // Only require DB TLS when explicitly configured (a managed DB with a cert).
    // A same-host Docker MySQL has no cert, so hard-forcing ssl:require aborts
    // the handshake and the backend can't boot. Leave DB_SSL unset in-compose.
    ...(process.env.DB_SSL === 'true'
      ? {
          dialectOptions: {
            ssl: {
              require: true,
              rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
            },
          },
        }
      : {}),
  },
};
