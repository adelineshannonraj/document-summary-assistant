let app;

try {
  app = require('../server');
  console.log('SERVER LOADED SUCCESSFULLY');
} catch (error) {
  console.error('SERVER STARTUP ERROR:', error);
  throw error;
}

module.exports = app;