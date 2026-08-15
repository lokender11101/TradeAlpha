const Redis = require('ioredis');
const redis = new Redis();
redis.psubscribe('market:tick:*');
redis.on('pmessage', (pattern, channel, message) => {
  console.log('Received:', channel, message);
  process.exit(0);
});
setTimeout(() => {
  console.log('No messages in 5s');
  process.exit(1);
}, 5000);
