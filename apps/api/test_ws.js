const Redis = require('ioredis');
const pubClient = new Redis();
const bridgeSubClient = pubClient.duplicate();

bridgeSubClient.psubscribe('market:tick:*', (err, count) => {
  console.log('Subscribed to', count);
});

bridgeSubClient.on('pmessage', (pattern, channel, message) => {
  console.log('pmessage:', pattern, channel, message);
});

setInterval(() => {}, 1000);
