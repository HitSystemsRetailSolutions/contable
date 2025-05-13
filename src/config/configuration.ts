export default () => ({
    debug: process.env.DEBUG?.toLowerCase() === 'true',
    mqtt: {
      host: process.env.MQTT_HOST,
      port: Number(process.env.MQTT_PORT),
      username: process.env.MQTT_USER,
      password: process.env.MQTT_PASSWORD,
      clientId: process.env.MQTT_CLIENT_ID,
    },
    db: {
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      server: process.env.DB_SERVER,
      database: process.env.DB_DATABASE,
    },
  });