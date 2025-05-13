import * as Joi from 'joi';

export const validationSchema = Joi.object({
  DEBUG: Joi.string().optional(),
  MQTT_HOST: Joi.string().required(),
  MQTT_PORT: Joi.number().required(),
  MQTT_USER: Joi.string().required(),
  MQTT_PASSWORD: Joi.string().required(),
  MQTT_CLIENT_ID: Joi.string().required(),
  DB_USER: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_SERVER: Joi.string().required(),
  DB_DATABASE: Joi.string().required(),
});