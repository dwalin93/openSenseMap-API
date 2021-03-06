/**
 * This is the openSenseMap API source code!
 * Booya!
 */

/**
 * define for the senseBox request body encoded in JSON
 * @apiDefine RequestBody JSON request body
 */

/**
 * define for a senseBox Sensor
 * @apiDefine Sensor A single sensor for the nested Sensor parameter
 */

/**
 * @apiDefine SensorBody
 *
 * @apiParam (Sensor) {String} title the title of the phenomenon the sensor observes.
 * @apiParam (Sensor) {String} unit the unit of the phenomenon the sensor observes.
 * @apiParam (Sensor) {String} sensorType the type of the sensor.
 * @apiParam (Sensor) {String} icon the visual representation for the openSenseMap of this sensor.
 *
 */

/**
 * define for the MQTT options
 * @apiDefine MqttOption Settings for a senseBox connected through MQTT
 */

/**
 * @apiDefine MqttBody
 *
 * @apiParam (MqttOption) {String} url the url to the mqtt server.
 * @apiParam (MqttOption) {String} topic the topic to subscribe to.
 * @apiParam (MqttOption) {String="json","csv"} messageFormat the format the mqtt messages are in.
 * @apiParam (MqttOption) {String} decodeOptions a json encoded string with options for decoding the message. 'jsonPath' for 'json' messageFormat.
 * @apiParam (MqttOption) {String} connectionOptions a json encoded string with options to supply to the mqtt client (https://github.com/mqttjs/MQTT.js#client)
 *
 */

/**
 * @apiDefine CommonBoxJSONBody
 *
 * @apiParam (RequestBody) {String} name the name of this senseBox.
 * @apiParam (RequestBody) {String} grouptag the grouptag of this senseBox.
 * @apiParam (RequestBody) {String="indoor","outdoor"} exposure the exposure of this senseBox.
 * @apiParam (RequestBody) {String} grouptag the grouptag of this senseBox.
 * @apiParam (RequestBody) {String="fixed"} boxType the type of the senseBox. Currently only 'fixed' is supported.
 * @apiParam (RequestBody) {Sensor[]} sensors an array containing the sensors of this senseBox.
 * @apiParam (RequestBody) {MqttOption} sensors an array containing the sensors of this senseBox.
 * @apiParam (RequestBody) {Location} loc the location of this senseBox. Must be a GeoJSON Point Feature. (RFC7946)
 *
 */

/**
 * @apiDefine AuthorizationRequiredError
 *
 * @apiHeader {String} x-apikey the secret API key which corresponds to the <code>senseBoxId</code> parameter.
 * @apiHeaderExample {String} x-apikey header example:
 *   x-apikey: 576efef4cb9b9ebe057bf7b4
 * @apiError {Object} 403 the request has invalid or missing credentials.
 * @apiErrorExample {json} Error-Response:
 *     HTTP/1.1 403 Forbidden
 *     {"code":"NotAuthorized","message":"ApiKey is invalid or missing"}
 */

/**
 * @apiDefine BoxIdParam
 *
 * @apiParam {String} :senseBoxId the ID of the senseBox you are referring to.
 */

/**
 * @apiDefine SensorIdParam
 *
 * @apiParam {String} :sensorId the ID of the sensor you are referring to.
 */

'use strict';

var restify = require('restify'),
  mongoose = require('mongoose'),
  fs = require('fs'),
  GeoJSON = require('geojson'),
  _ = require('lodash'),
  models = require('./lib/models'),
  csvstringify = require('csv-stringify'),
  csvtransform = require('stream-transform'),
  Stream = require('stream'),
  moment = require('moment'),
  request = require('request'),
  mails = require('./lib/mails'),
  util = require('util'),
  jsonstringify = require('stringify-stream'),
  utils = require('./lib/utils'),
  decodeHandlers = require('./lib/decoding');

var Honeybadger = utils.Honeybadger,
  cfg = utils.config;

mongoose.Promise = require('bluebird');

// Logging
var consoleStream = new Stream();
consoleStream.writable = true;
consoleStream.write = function (obj) {
  if (obj.req) {
    console.log(obj.time, obj.req.remoteAddress, obj.req.method, obj.req.url);
  } else if (obj.msg) {
    console.log(obj.time, obj.msg);
  } else {
    //console.log(obj.time, obj);
  }
};

var Logger = require('bunyan'),
  reqlog = new Logger.createLogger({
    name: 'OSeM-API',
    streams: [
      { level: 'debug', type: 'raw', stream: consoleStream }
    ],
    serializers: {
      err: Logger.stdSerializers.err,
      req: Logger.stdSerializers.req,
      res: Logger.stdSerializers.res
    }
  }),
  log = new Logger.createLogger({
    name: 'OSeM-API',
    streams: [
      { level: 'debug', type: 'raw', stream: consoleStream }
    ],
    serializers: {
      err: Logger.stdSerializers.err,
      req: Logger.stdSerializers.req,
      res: Logger.stdSerializers.res
    }
  });

var PATH = '/boxes';
var userPATH = 'users';

var server = restify.createServer({
  name: 'opensensemap-api',
  version: '0.0.1',
  log: reqlog
});

// We're using caddy as proxy. It supplies a 'X-Forwarded-Proto' header
// which contains the request scheme (http/https)
// respond every GET request with a notice to use the https api.
// Also allow POST measurements through unsecured
// /boxes/:boxId/data and /boxes/:boxId/:sensorId for arduinos
// and set utf-8 charset
let validUnsecuredPathRegex = new RegExp('^\\' + PATH + '\/[a-f\\d]{24}\/((data)|([a-f\\d]{24}))\/?$', 'i');
server.pre(function (request, response, next) {
  response.charSet('utf-8');
  request.log.info({req: request}, 'REQUEST');

  if (process.env.ENV === 'prod'
    && (!request.headers['x-forwarded-proto'] || request.headers['x-forwarded-proto'] !== 'https')) {
    if (request.method !== 'POST' || !validUnsecuredPathRegex.test(request.url)) {
      return next(new restify.NotAuthorizedError('Access through http is not allowed'));
    }
  }
  return next();
});
server.use(restify.CORS({'origins': ['*'] })); //['http://localhost', 'https://opensensemap.org']}));
server.use(restify.fullResponse());
server.use(restify.queryParser());
server.use(restify.jsonBodyParser());
server.pre(restify.pre.sanitizePath());

var Measurement = models.Measurement,
  Box = models.Box,
  Sensor = models.Sensor,
  User = models.User;

// the ones matching first are used
// case is ignored
const VALID_BOX_ID_PARAMS = [ 'senseboxid', 'senseboxids', 'boxid', 'boxids' ];

// attach a function to validate boxId and sensorId parameters
server.use(function validateIdParams (req, res, next) {
  // check parmeters for possible box Id parameters
  // everything of the like
  // 'boxId', 'boxid', 'senseBoxIds', 'senseBoxId'
  // can be used
  let boxIdParamName;
  for (let param of Object.keys(req.params)) {
    if (VALID_BOX_ID_PARAMS.includes(param.toLowerCase())) {
      boxIdParamName = param;
      req.boxId = req.params[param].toString();
      break;
    }
  }

  if (typeof req.boxId !== 'undefined') {
    let boxId = req.boxId;
    if (boxId.indexOf(',') !== -1) {
      boxId = boxId.split(',');
    } else {
      boxId = [boxId];
    }
    if (boxId.some(id => !mongoose.Types.ObjectId.isValid(id))) {
      next(new restify.BadRequestError('Parameter :' + boxIdParamName + ' is not valid'));
    }
  }

  if (typeof req.params['sensorId'] !== 'undefined') {
    let sensorId = req.params['sensorId'].toString();
    if (sensorId && !mongoose.Types.ObjectId.isValid(sensorId)) {
      next(new restify.BadRequestError('Parameter :sensorId is not valid'));
    }
  }
  next();
});

// GET
server.get({path: PATH , version: '0.0.1'} , findAllBoxes);
// explanation for this route:
// the regex matches strings like 'boxes.blabla' where 'blaba' could be 'geojson' or 'json'
// this does not work anymore but I might consider reimplementing it..
server.get({path: /(boxes)\.([a-z]+)/, version: '0.1.0'} , findAllBoxes);
server.get({path: PATH + '/:boxId' , version: '0.0.1'} , findBox);
server.get({path: PATH + '/:boxId/sensors', version: '0.0.1'}, getMeasurements);
server.get({path: PATH + '/:boxId/data/:sensorId', version: '0.0.1'}, getData);
server.get({path: PATH + '/data', version: '0.1.0'}, getDataMulti);
server.get({path: '/stats', version: '0.1.0'}, getStatistics);
server.get({path: PATH + '/:boxId/:sensorId/submitMeasurement/:value' , version: '0.0.1'}, postNewMeasurement);

// POST
server.post({path: PATH , version: '0.0.1'}, postNewBox);
server.post({path: PATH + '/:boxId/:sensorId' , version: '0.0.1'}, postNewMeasurement);
server.post({path: PATH + '/:boxId/data' , version: '0.1.0'}, postNewMeasurements);
server.post({path: PATH + '/data', version: '0.1.0'}, getDataMulti);

// Secured (needs authorization through apikey)

// attach a function to secured requests to validate api key and box id
server.use(function validateAuthenticationRequest (req, res, next) {
  if (req.headers['x-apikey'] && req.boxId) {
    User.findOne({ apikey: req.headers['x-apikey'], boxes: { $in: [ req.boxId ] } })
      .then(function (user) {
        if (user && user.boxes.length > 0) {
          const boxIds = user.boxes.map(boxId => boxId.toString());
          if (boxIds.includes(req.boxId)) {
            req.authorized_user = user;
            return next();
          }
        }
        next(new restify.NotAuthorizedError('ApiKey is invalid or missing'));
      })
      .catch(function (err) {
        console.log(err);
        Honeybadger.notify(err);
        next(new restify.InternalServerError());
      });
  } else {
    next(new restify.NotAuthorizedError('ApiKey is invalid or missing'));
  }
});

// GET
server.get({path: userPATH + '/:boxId', version: '0.0.1'}, validApiKey);
server.get({path: PATH + '/:boxId/script', version: '0.1.0'}, getScript);

// PUT
server.put({path: PATH + '/:boxId' , version: '0.1.0'} , updateBox);

// DELETE
server.del({path: PATH + '/:boxId' , version: '0.1.0'} , deleteBox);


// helper function to determine the requested format
function getFormat (req, allowed_formats, default_format) {
  if (typeof req.params['format'] === 'undefined' || req.params['format'].trim() === '') {
    return default_format;
  } else if (allowed_formats.indexOf(req.params['format'].trim().toLowerCase()) !== -1) {
    return req.params['format'].trim().toLowerCase();
  }
}

/**
 * @apiDefine SeparatorParam
 *
 * @apiParam {String} separator Only for csv: the separator for csv. Possible values: `comma` for comma as separator, everything else: semicolon. Per default a semicolon is used.
 */

// helper to determine the requested separator for csv
function getSeparator (req) {
  if (typeof req.params['separator'] !== 'undefined' && req.params['separator'].trim().toLowerCase() === 'comma') {
    return ',';
  } else {
    return ';';
  }
}

function unknownMethodHandler (req, res) {
  if (req.method.toLowerCase() === 'options') {
    var allowHeaders = ['Accept', 'X-ApiKey', 'Accept-Version', 'Content-Type', 'Api-Version', 'Origin', 'X-Requested-With']; // added Origin & X-Requested-With

    if (res.methods.indexOf('OPTIONS') === -1) {
      res.methods.push('OPTIONS');
    }

    res.header('Access-Control-Allow-Credentials', true);
    res.header('Access-Control-Allow-Headers', allowHeaders.join(', '));
    res.header('Access-Control-Allow-Methods', res.methods.join(', '));
    res.header('Access-Control-Allow-Origin', req.headers.origin);

    return res.send(204);
  } else {
    return res.send(new restify.MethodNotAllowedError());
  }
}

server.on('MethodNotAllowed', unknownMethodHandler);

/**
 * @api {get} /users/:senseBoxId Validate authorization
 * @apiGroup Boxes
 * @apiUse AuthorizationRequiredError
 * @apiUse BoxIdParam
 * @apiParam {String} returnBox if supplied and non-empty, returns the senseBox with the senseBoxId with hidden fields
 * @apiDescription Validate authorization through API key and senseBoxId. Will return status code 403 if invalid, 200 if valid.
 * @apiSuccess {String} Response ApiKey is valid
 * @apiVersion 0.0.1
 * @apiName validApiKey
 */
function validApiKey (req, res, next) {
  if (req.params['returnBox']) {
    Box.findAndPopulateBoxById(req.boxId)
      .then(function (box) {
        if (box) {
          res.send(box);
        } else {
          return next(new restify.NotFoundError('senseBox not found'));
        }
      })
      .catch(function (error) {
        var e = error.errors;
        Honeybadger.notify(error);
        return next(new restify.InternalServerError(e));
      });
  } else {
    res.send(200, 'ApiKey is valid');
  }
}

function decodeBase64Image (dataString) {
  var matches = dataString.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/),
    response = {};

  if (matches.length !== 3) {
    return new Error('Invalid input string');
  }

  response.type = matches[1];
  response.data = new Buffer(matches[2], 'base64');

  return response;
}

/**
 * @api {put} /boxes/:senseBoxId Update a senseBox: Image and sensor names
 * @apiDescription Modify the specified senseBox.
 *
 * @apiUse CommonBoxJSONBody
 * @apiUse SensorBody
 * @apiUse MqttBody
 *
 * @apiParam (RequestBody) {String} description the updated description of this senseBox.
 * @apiParam (RequestBody) {String} image the updated image of this senseBox encoded as base64 data uri.
 * @apiParamExample {json} Request-Example:
 * {
 *  "_id": "56e741ff933e450c0fe2f705",
 *  "name": "my senseBox",
 *  "description": "this is just a description",
 *  "weblink": "https://opensensemap.org/explore/561ce8acb3de1fe005d3d7bf",
 *  "grouptag": "senseBoxes99",
 *  "exposure": "indoor",
 *  "sensors": [
 *    {
 *      "_id": "56e741ff933e450c0fe2f707",
 *      "title": "UV-Intensität",
 *      "unit": "μW/cm²",
 *      "sensorType": "VEML6070",
 *      "icon": "osem-sprinkles"
 *    }
 *  ],
 *  "loc": {
 *    "lng": 8.6956,
 *    "lat": 50.0430
 *  },
 *  "image": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAIVBMVEUAAABKrkMGteh0wW5Ixu931vKy3bO46fj/7hr/+J36/vyFw5EiAAAAAXRSTlMAQObYZgAAAF5JREFUeAFdjdECgzAIA1kIUvP/HzyhdrPe210L2GLYzhjj7VvRefmpn1MKFbdHUOzA9qRQEhIw3xMzEVeJDqkOrC9IJqWE7hFDLZ0Q6+zh7odsoU/j9qeDPXDf/cEX1xsDKIqAkK8AAAAASUVORK5CYII=",
 *  "mqtt": {
 *    "url": "some url",
 *    "topic": "some topic",
 *    "messageFormat": "json",
 *    "decodeOptions": "{\"jsonPath\":\"$.bla\"}"
 *  }
 * }
 * @apiVersion 0.0.1
 * @apiGroup Boxes
 * @apiName updateBox
 * @apiUse AuthorizationRequiredError
 * @apiUse BoxIdParam
 *
 */
function updateBox (req, res, next) {
  /*
  var newBoxData = {
    _id
    name
    sensors
    description
    weblink
    grouptag
    exposure
    loc
    image
  };
  */
  utils.checkContentType(req, next);

  var qrys = [];
  Box.findById(req.boxId).then(function (box) {
    if (typeof req.params.name !== 'undefined' && req.params.name !== '') {
      if (box.name !== req.params.name) {
        qrys.push(box.set({name: req.params.name}));
      }
    }
    if (typeof req.params.exposure !== 'undefined' && req.params.exposure !== '') {
      if (box.exposure !== req.params.exposure) {
        qrys.push(box.set({exposure: req.params.exposure}));
      }
    }
    if (typeof req.params.grouptag !== 'undefined' && req.params.grouptag !== '') {
      if (box.grouptag !== req.params.grouptag) {
        qrys.push(box.set({grouptag: req.params.grouptag}));
      }
    }
    if (typeof req.params.weblink !== 'undefined' && req.params.weblink !== '') {
      if (box.weblink !== req.params.weblink) {
        qrys.push(box.set({weblink: req.params.weblink}));
      }
    }
    if (typeof req.params.description !== 'undefined' && req.params.description !== '') {
      if (box.description !== req.params.description) {
        qrys.push(box.set({description: req.params.description}));
      }
    }
    if (typeof req.params.loc !== 'undefined' && req.params.loc !== '') {
      if (String(box.loc[0].geometry.coordinates[0]) !== req.params.loc.lng || String(box.loc[0].geometry.coordinates[1]) !== req.params.loc.lat) {
        box.loc[0].geometry.coordinates = [req.params.loc.lng, req.params.loc.lat];
      }
    }
    if (typeof req.params.image !== 'undefined' && req.params.image !== '') {
      var data = req.params.image.toString();
      var imageBuffer = decodeBase64Image(data);
      var extension = (imageBuffer.type === 'image/jpeg') ? '.jpg' : '.png';
      try {
        fs.writeFileSync(cfg.imageFolder + '' + req.boxId + extension, imageBuffer.data);
        qrys.push(box.set({image: req.boxId + extension + '?' + (new Date().getTime())}));
      } catch (e) {
        return next(new restify.InternalServerError(JSON.stringify(e.message)));
      }
    }
    if (req.params.mqtt === null) {
      qrys.push(box.set('mqtt', {}));
    } else if (typeof req.params.mqtt !== 'undefined' && typeof req.params.mqtt.url !== 'undefined' && typeof req.params.mqtt.topic !== 'undefined') {
      qrys.push(box.set({ 'mqtt': req.params.mqtt}));
    }
    if (typeof req.params.sensors !== 'undefined' && req.params.sensors.length > 0) {
      req.params.sensors.forEach(function (updatedsensor) {
        if (updatedsensor.deleted) {
          qrys.push(Measurement.find({ sensor_id: updatedsensor._id }).remove());
          qrys.push(Box.update({'sensors._id': mongoose.Types.ObjectId(updatedsensor._id)},
            { $pull: { 'sensors': { _id: mongoose.Types.ObjectId(updatedsensor._id) } }
          }));
        } else if (updatedsensor.edited && updatedsensor.new) {
          var newsensor = new Sensor({
            'title': updatedsensor.title,
            'unit': updatedsensor.unit,
            'sensorType': updatedsensor.sensorType,
            'icon': updatedsensor.icon
          });
          box.sensors.push(newsensor);
        } else if (updatedsensor.edited && !updatedsensor.deleted) {
          qrys.push(Box.update({'sensors._id': mongoose.Types.ObjectId(updatedsensor._id)}, {'$set': {
            'sensors.$.title': updatedsensor.title,
            'sensors.$.unit': updatedsensor.unit,
            'sensors.$.sensorType': updatedsensor.sensorType,
            'sensors.$.icon': updatedsensor.icon
          }}));
        }
      });
    }
    qrys.push(box.save());

    Promise.all(qrys).then(function () {
      genScript(box, box.model);
      res.send(200, box);
    }).catch(function (err) {
      Honeybadger.notify(err);
      return next(new restify.InternalServerError(JSON.stringify(err.message)));
    });
  }).catch(function (err) {
    Honeybadger.notify(err);
    return next(new restify.InternalServerError(JSON.stringify(err.message)));
  });
}

/**
 * @api {get} /boxes/:senseBoxId/sensors Get latest measurements of a senseBox
 * @apiDescription Get the latest measurements of all sensors of the specified senseBox.
 * @apiVersion 0.0.1
 * @apiGroup Measurements
 * @apiName getMeasurements
 * @apiUse BoxIdParam
 */
function getMeasurements (req, res, next) {
  Box.findOne({ _id: req.boxId }, { sensors: 1 })
    .populate('sensors.lastMeasurement')
    .lean()
    .exec()
    .then(function (box_with_sensors) {
      if (box_with_sensors) {
        box_with_sensors.sensors = box_with_sensors.sensors.map(function (sensor) {
          if (sensor.lastMeasurement) {
            sensor.lastMeasurement.__v = undefined;
            sensor.lastMeasurement.updatedAt = undefined;
          }

          return sensor;
        });
        res.send(200, box_with_sensors);
      } else {
        return next(new restify.NotFoundError('box not found'));
      }
    })
    .catch(function (error) {
      console.log(error);
      Honeybadger.notify(error);
      return next(new restify.InternalServerError());
    });
}

/**
 * @api {get} /boxes/:senseBoxId/data/:sensorId?from-date=fromDate&to-datetoDate&download=true&format=json Get the 10000 latest measurements for a sensor
 * @apiDescription Get up to 10000 measurements from a sensor for a specific time frame, parameters `from-date` and `to-date` are optional. If not set, the last 48 hours are used. The maximum time frame is 1 month. If `download=true` `Content-disposition` headers will be set. Allows for JSON or CSV format.
 * @apiVersion 0.0.1
 * @apiGroup Measurements
 * @apiName getData
 * @apiUse BoxIdParam
 * @apiUse SensorIdParam
 * @apiParam {String} from-date Beginning date of measurement data (default: 48 hours ago from now)
 * @apiParam {String} to-date End date of measurement data (default: now)
 * @apiParam {String="true","false"} download If set, offer download to the user (default: false, always on if CSV is used)
 * @apiParam {String="json","csv"} format=json Can be 'json' (default) or 'csv' (default: json)
 * @apiUse SeparatorParam
 */
function getData (req, res, next) {
  // default to now
  var toDate = utils.parseTimeParameter(req, next, 'to-date', moment());
  if (!moment.isMoment(toDate)) {
    return next(toDate);
  }

  // default to 48 hours earlier from to-date
  var fromDate = utils.parseTimeParameter(req, next, 'from-date', toDate.clone().subtract(48, 'hours'));
  if (!moment.isMoment(fromDate)) {
    return next(fromDate);
  }

  // validate time parameters
  var timesValid = utils.validateTimeParameters(toDate, fromDate);
  if (typeof timesValid !== 'undefined') {
    return next(timesValid);
  }

  var format = getFormat(req, ['json', 'csv'], 'json');
  if (typeof format === 'undefined') {
    return next(new restify.InvalidArgumentError('Invalid format: ' + req.params['format']));
  }

  var stringifier;

  var csvTransformer = csvtransform(function (data) {
    data.createdAt = new Date(data.createdAt).toISOString();
    return data;
  });
  csvTransformer.on('error', (err) => {
    console.log(err.message);
    Honeybadger.notify(err);
    return next(new restify.InternalServerError(err.message));
  });

  if (format === 'csv') {
    res.header('Content-Type', 'text/csv');
    var sep = getSeparator(req);
    stringifier = csvstringify({ columns: ['createdAt', 'value'], header: 1, delimiter: sep });
  } else if (format === 'json') {
    res.header('Content-Type', 'application/json; charset=utf-8');
    stringifier = jsonstringify({ open: '[', close: ']' });
  }

  stringifier.on('error', (err) => {
    console.log(err.message);
    Honeybadger.notify(err);
    return next(new restify.InternalServerError(err.message));
  });

  // offer download to browser
  if (format === 'csv' || (typeof req.params['download'] !== 'undefined' && req.params['download'] === 'true')) {
    res.header('Content-Disposition', 'attachment; filename=' + req.params.sensorId + '.' + format);
  }

  // finally execute the query
  var queryLimit = 10000;

  var qry = {
    sensor_id: req.params.sensorId,
    createdAt: { $gte: fromDate.toDate(), $lte: toDate.toDate() }
  };

  Measurement.find(qry,{'createdAt': 1, 'value': 1, '_id': 0}) // do not send _id column
    .limit(queryLimit)
    .lean()
    .cursor({ batchSize: 500 })
    .pipe(csvTransformer)
    .pipe(stringifier)
    .pipe(res);
}

/**
 * @api {get,post} /boxes/data?boxid=:senseBoxIds&from-date=:fromDate&to-date:toDate&phenomenon=:phenomenon Get latest measurements for a phenomenon as CSV
 * @apiDescription Download data of a given phenomenon from multiple selected senseBoxes as CSV
 * @apiVersion 0.1.0
 * @apiGroup Measurements
 * @apiName getDataMulti
 * @apiParam {String} senseBoxIds Comma separated list of senseBox IDs.
 * @apiParam {String} phenomenon the name of the phenomenon you want to download the data for.
 * @apiParam {String} from-date Beginning date of measurement data (default: 15 days ago from now)
 * @apiParam {String} to-date End date of measurement data (default: now)
 * @apiUse SeparatorParam
 * @apiParam {String} columns (optional) Comma separated list of columns to export. If omitted, columns createdAt, value, lat, lng are returned. Possible allowed values are createdAt, value, lat, lng, unit, boxId, sensorId, phenomenon, sensorType, boxName. The columns in the csv are like the order supplied in this parameter
 */
const GET_DATA_MULTI_DEFAULT_COLUMNS = ['createdAt', 'value', 'lat', 'lng'];
const GET_DATA_MULTI_ALLOWED_COLUMNS = ['createdAt', 'value', 'lat', 'lng', 'unit', 'boxId', 'sensorId', 'phenomenon', 'sensorType', 'boxName'];

function getDataMulti (req, res, next) {
  // default to now
  var toDate = utils.parseTimeParameter(req, next, 'to-date', moment().utc());
  if (!moment.isMoment(toDate)) {
    return next(toDate);
  }

  // default to 15 days earlier
  var fromDate = utils.parseTimeParameter(req, next, 'from-date', toDate.clone().subtract(15, 'days'));
  if (!moment.isMoment(fromDate)) {
    return next(fromDate);
  }

  // validate time parameters
  var timesValid = utils.validateTimeParameters(toDate, fromDate);
  if (typeof timesValid !== 'undefined') {
    return next(timesValid);
  }

  if (req.params['phenomenon'] && req.boxId) {
    var phenom = req.params['phenomenon'].toString();
    var boxId = req.boxId.toString();
    var boxIds = boxId.split(',');

    res.header('Content-Type', 'text/csv');
    Box.find({
      '_id': {
        '$in': boxIds
      },
      'sensors.title': req.params['phenomenon'].toString()
    })
      .lean()
      .exec()
      .then(function (boxData) {
        var sensors = Object.create(null);

        for (var i = 0, len = boxData.length; i < len; i++) {
          for (var j = 0, sensorslen = boxData[i].sensors.length; j < sensorslen; j++) {
            if (boxData[i].sensors[j].title === phenom) {
              let sensor = boxData[i].sensors[j];

              sensor.lat = boxData[i].loc[0].geometry.coordinates[0];
              sensor.lng = boxData[i].loc[0].geometry.coordinates[1];
              sensor.boxId = boxData[i]._id.toString();
              sensor.boxName = boxData[i].name;
              sensor.sensorId = sensor._id.toString();
              sensor.phenomenon = sensor.title;

              sensors[boxData[i].sensors[j]['_id']] = sensor;
            }
          }
        }

        let sep = getSeparator(req);
        let columns = GET_DATA_MULTI_DEFAULT_COLUMNS;
        let columnsParam = req.params['columns'];
        if (typeof columnsParam !== 'undefined' && columnsParam.trim() !== '') {
          columns = columnsParam.split(',');
          if (columns.some(c => !GET_DATA_MULTI_ALLOWED_COLUMNS.includes(c))) {
            return next(new restify.UnprocessableEntityError('illegal columns'));
          }
        }

        let stringifier = csvstringify({ columns: columns, header: 1, delimiter: sep });
        let transformer = csvtransform(function (data) {
          data.createdAt = utils.parseTimestamp(data.createdAt).toISOString();

          for (let col of columns) {
            if (!data[col]) {
              data[col] = sensors[data.sensor_id][col];
            }
          }

          return data;
        });

        transformer.on('error', function (err) {
          console.log(err.message);
          Honeybadger.notify(err);
          return next(new restify.InternalServerError(JSON.stringify(err.message)));
        });

        Measurement.find({
          'sensor_id': {
            '$in': Object.keys(sensors)
          },
          createdAt: {
            '$gt': fromDate.toDate(),
            '$lt': toDate.toDate()
          }
        }, {'createdAt': 1, 'value': 1, '_id': 0, 'sensor_id': 1})
          .lean()
          .cursor({ batchSize: 500 })
          .pipe(transformer)
          .pipe(stringifier)
          .pipe(res);
      })
      .catch(function (err) {
        console.log(err);
        Honeybadger.notify(err);
        return next(new restify.InternalServerError(JSON.stringify(err.errors)));
      });
  } else {
    return next(new restify.InvalidArgumentError('Invalid parameters'));
  }
}

/**
 * @api {post} /boxes/:senseBoxId/:sensorId Post new measurement
 * @apiDescription Posts a new measurement to a specific sensor of a box.
 * @apiVersion 0.0.1
 * @apiGroup Measurements
 * @apiName postNewMeasurement
 * @apiUse BoxIdParam
 * @apiUse SensorIdParam
 * @apiParam (RequestBody) {String} value the measured value of the sensor. Also accepts JSON float numbers.
 * @apiParam (RequestBody) {String} createdAt the timestamp of the measurement. Should be parseable by JavaScript.
 */
function postNewMeasurement (req, res, next) {
  let jsonHandler = decodeHandlers.json;
  // decode the body..
  let measurements;
  try {
    measurements = jsonHandler.decodeMessage([{
      sensor_id: req.params.sensorId,
      value: req.params.value,
      createdAt: req.params.createdAt
    }]);
  } catch (err) {
    return next(new restify.UnprocessableEntityError(err.message));
  }
  Box.findOne({ _id: req.boxId })
    .then(function (box) {
      if (!box) {
        return next(new restify.NotFoundError('no senseBox found'));
      } else {
        return box.saveMeasurement(measurements[0]);
      }
    })
    .then(function () {
      res.send(201, 'Measurement saved in box');
    })
    .catch(function (err) {
      console.log(err);
      Honeybadger.notify(err);
      return next(new restify.UnprocessableEntityError(err.message + '. ' + err));
    });
}

/**
 * I think this shouldn't be documented for now
 * api {post} /boxes/:boxId/data Post multiple new measurements
 * @apiDescription Post multiple new measurements as an JSON array to a box.
 * @apiVersion 0.1.0
 * @apiGroup Measurements
 * @apiName postNewMeasurements
 * @apiUse BoxIdParam
 * @apiParam (RequestBody) {Object[]} bla bla
 * @apiSampleRequest
 * [{ "sensor": "56cb7c25b66992a02fe389de", "value": "3" },{ "sensor": "56cb7c25b66992a02fe389df", "value": "2" }]
 * curl -X POST -H 'Content-type:application/json' -d "[{ \"sensor\": \"56cb7c25b66992a02fe389de\", \"value\": \"3\" },{ \"sensor\": \"56cb7c25b66992a02fe389df\", \"value\": \"2\" }]" localhost:8000/boxes/56cb7c25b66992a02fe389d9/data
 */
function postNewMeasurements (req, res, next) {
  // when the body is an array, restify overwrites the req.params with the given array.
  // to get the boxId, try to extract it from the path
  var boxId = req.path().split('/')[2];
  let handler = decodeHandlers[req.contentType().toLowerCase()];
  if (handler) {
    // decode the body..
    let measurements;
    try {
      measurements = handler.decodeMessage(req.body);
    } catch (err) {
      return next(new restify.UnprocessableEntityError(err.message));
    }
    Box.findOne({ _id: boxId })
      .then(function (box) {
        if (!box) {
          return next(new restify.NotFoundError('no senseBox found'));
        } else {
          return box.saveMeasurementsArray(measurements);
        }
      })
      .then(function () {
        res.send(201, 'Measurements saved in box');
      })
      .catch(function (err) {
        console.log(err);
        Honeybadger.notify(err);
        return next(new restify.UnprocessableEntityError(err.message + '. ' + err));
      });
  } else {
    return next(new restify.UnsupportedMediaTypeError('Unsupported content-type.'));
  }
}

/**
 * @api {get} /boxes?date=:date&phenomenon=:phenomenon&format=:format Get all senseBoxes
 * @apiDescription With the optional `date` and `phenomenon` parameters you can find senseBoxes that have submitted data around that time, +/- 2 hours, or specify two dates separated by a comma.
 * @apiName findAllBoxes
 * @apiGroup Boxes
 * @apiVersion 0.1.0
 * @apiParam {String} date A date or datetime (UTC) where a station should provide measurements. Use in combination with `phenomenon`.
 * @apiParam {String} phenomenon A sensor phenomenon (determined by sensor name) such as temperature, humidity or UV intensity. Use in combination with `date`.
 * @apiParam {String="json","geojson"} format=json the format the sensor data is returned in.
 * @apiSampleRequest https://api.opensensemap.org/boxes
 * @apiSampleRequest https://api.opensensemap.org/boxes?date=2015-03-07T02:50Z&phenomenon=Temperatur
 * @apiSampleRequest https://api.opensensemap.org/boxes?date=2015-03-07T02:50Z,2015-04-07T02:50Z&phenomenon=Temperatur
 */
function findAllBoxes (req, res , next) {
  var activityAroundDate = (typeof req.params['date'] === 'undefined' || req.params['date'] === '') ? undefined : req.params['date'];
  var phenomenon = (typeof req.params['phenomenon'] === 'undefined' || req.params['phenomenon'] === '') ? undefined : req.params['phenomenon'];

  var format = getFormat(req, ['json', 'geojson'], 'json');
  if (typeof format === 'undefined') {
    return next(new restify.InvalidArgumentError('Invalid format: ' + req.params['format']));
  }

  var fromDate,
    toDate,
    dates;

  if (activityAroundDate && (dates = activityAroundDate.split(',')) && dates.length === 2 && moment(dates[0]).isBefore(dates[1])) { // moment().isBefore() will check the date's validities as well
    fromDate = moment.utc(dates[0]).toDate();
    toDate = moment.utc(dates[1]).toDate();
  } else if (moment(activityAroundDate).isValid()) {
    fromDate = moment.utc(activityAroundDate).subtract(4, 'hours').toDate();
    toDate = moment.utc(activityAroundDate).add(4, 'hours').toDate();
  }

  // prepare query & callback
  var boxQry = Box.find({}).populate('sensors.lastMeasurement');
  var boxQryCallback = function (err, boxes) {
    // extend/update 'lastMeasurement' to the queried date
    var sensorQrys = [];
    if (typeof activityAroundDate !== 'undefined') {
      boxes.forEach(function (box) {
        box.sensors.forEach(function (sensor) {
          sensorQrys.push(
            Measurement.findOne({
              sensor_id: sensor._id,
              createdAt: {
                '$gt': fromDate,
                '$lt': toDate
              }
            }).lean().exec()
          );
        });
      });
    }

    Promise.all(sensorQrys).then(function (thatresult) {
      // merge 'old' data that was queried according to the date/timestamp into the box result set
      // by replacing the "lastMeasurement" attribute's values with one fitting the query
      if (typeof activityAroundDate !== 'undefined'/* && typeof phenomenon !== 'undefined'*/) {
        var _boxes = boxes.slice();
        // TODO: too many loops
        _boxes.forEach(function (box) {
          box.sensors.forEach(function (sensor) {
            thatresult.forEach(function (thisresult) {
              if (thisresult !== null) {
                if (sensor.lastMeasurement) {
                  if (thisresult.sensor_id.toString() === sensor._id.toString()) {
                    sensor.lastMeasurement = thisresult;
                  }
                }
              }
            });
          });
        });
        return (_boxes);
      }
      return (boxes);
    })
      .then(function (result_boxes) {
      // clean up result..
        return result_boxes.map(function (box) {
          box.__v = undefined;
          box.mqtt = undefined;

          box.sensor = box.sensors.map(function (sensor) {
            sensor.__v = undefined;
            if (sensor.lastMeasurement) {
              sensor.lastMeasurement.__v = undefined;
            }
            return sensor;
          });

          box.loc[0]._id = undefined;

          return box;
        });
      })
      .then(function (resultset) {
        if (format === 'json') {
          res.send(resultset);
        } else if (format === 'geojson') {
          var tmp = JSON.stringify(resultset);
          tmp = JSON.parse(tmp);
          var geojson = _.transform(tmp, function (result, n) {
            var lat = n.loc[0].geometry.coordinates[1];
            var lng = n.loc[0].geometry.coordinates[0];
            n['loc'] = undefined;
            n['lat'] = lat;
            n['lng'] = lng;
            return result.push(n);
          });
          res.send(GeoJSON.parse(geojson, {Point: ['lat','lng']}));
        }

      }).catch(function (err) {
        console.log(err);
        Honeybadger.notify(err);
        return next(new restify.InternalServerError(JSON.stringify(err)));
      });
  };

  // if date and phenom. are specified then filter boxes,
  // otherwise show all boxes
  if (typeof activityAroundDate !== 'undefined') {
    Measurement.find({
      createdAt: {
        '$gt': fromDate,
        '$lt': toDate
      }
    }).lean().distinct('sensor_id', function (err,measurements) {
      var qry = {
        'sensors._id': {
          '$in': measurements
        }
      };
      if (typeof phenomenon !== 'undefined') {
        qry = {
          'sensors._id': {
            '$in': measurements
          },
          'sensors.title': phenomenon
        };
      }
      boxQry = Box.find(qry).populate('sensors.lastMeasurement');
      boxQry.exec(boxQryCallback);
    });
  } else {
    boxQry.exec(boxQryCallback);
  }
}

/**
 * @api {get} /boxes/:boxId Get one senseBox
 * @apiName findBox
 * @apiVersion 0.0.1
 * @apiGroup Boxes
 * @apiUse BoxIdParam
 * @apiParam {String="json","geojson"} format=json the format the sensor data is returned in.
 * @apiSuccessExample Example data on success:
 * {
  "_id": "5386e44d5f08822009b8b614",
  "name": "PHOBOS",
  "boxType": "fixed",
  "sensors": [
    {
      "_id": "5386e44d5f08822009b8b615",
      "boxes_id": "5386e44d5f08822009b8b614",
      "lastMeasurement": {
        "_id": "5388d07f5f08822009b937b7",
        "createdAt": "2014-05-30T18:39:59.353Z",
        "updatedAt": "2014-05-30T18:39:59.353Z",
        "value": "584",
        "sensor_id": "5386e44d5f08822009b8b615",
      },
      "sensorType": "GL5528",
      "title": "Helligkeit",
      "unit": "Pegel"
    }
  ],
  "loc": [
    {
      "_id": "5386e44d5f08822009b8b61a",
      "geometry": {
        "coordinates": [
          10.54555893642828,
          49.61361673283691
        ],
        "type": "Point"
      },
      "type": "feature"
    }
  ]
}
 */

function findBox (req, res, next) {
  var format = getFormat(req, ['json', 'geojson'], 'json');
  if (typeof format === 'undefined') {
    return next(new restify.InvalidArgumentError('Invalid format: ' + req.params['format']));
  }

  Box.findAndPopulateBoxById(req.boxId)
    .then(function (box) {
      if (box) {
        // do not send out mqtt credentials to everyone
        box.mqtt = undefined;
        if (format === 'json') {
          res.send(box);
        } else if (format === 'geojson') {
          var tmp = JSON.stringify(box);
          tmp = JSON.parse(tmp);
          var lat = tmp.loc[0].geometry.coordinates[1];
          var lng = tmp.loc[0].geometry.coordinates[0];
          tmp['loc'] = undefined;
          tmp['lat'] = lat;
          tmp['lng'] = lng;
          var geojson = [tmp];
          res.send(GeoJSON.parse(geojson, {Point: ['lat','lng']}));
        }
      } else {
        return next(new restify.NotFoundError('No senseBox found'));
      }
    })
    .catch(function (error) {
      var e = error.errors;
      Honeybadger.notify(error);
      return next(new restify.InternalServerError(e));
    });
}

/**
 * @api {post} /boxes Post new senseBox
 * @apiDescription Create a new senseBox. This method allows you to submit a new senseBox.
 *
 * Along with the senseBox, an user is created which then owns the senseBox.
 *
 * If you specify `mqtt` parameters, the openSenseMap API will try to connect to the MQTT broker
 * specified by you. The parameter `messageFormat` tells the API in which format you are sending
 * measurements in.
 *
 * For `json`, the format is:
 * ```
 * {
 *   "sensorId": <value>,
 *   "sensorId": [<value>,<createdAt>]
 *   ...
 * }
 * ```
 *
 * For `csv`, the format is:
 * ```
 * sensorId,value
 * sensorId,value,createdAt
 * ...
 * ```
 * @apiVersion 0.0.1
 * @apiGroup Boxes
 * @apiName postNewBox
 * @apiUse CommonBoxJSONBody
 * @apiUse SensorBody
 * @apiUse MqttBody
 *
 * @apiParam (RequestBody) {String} firstname firstname of the user for the senseBox.
 * @apiParam (RequestBody) {String} lastname lastname of the user for the senseBox.
 * @apiParam (RequestBody) {String} email email of the user for the senseBox.
 * @apiParam (RequestBody) {String} orderID the apiKey of the user for the senseBox.
 */
function postNewBox (req, res, next) {
  utils.checkContentType(req, next);
  log.debug('A new sensebox is being submitted');
  var newBox = Box.newFromRequest(req);

  User.createForBoxRequest(newBox, req)
    .then(function (user) {
      // user is saved at this point, newBox not
      // try to save the box
      return newBox.save()
        .then(function (box) {
          // box is now saved
          // generate the script and send mails
          // also post to slack
          try {
            genScript(box, box.model);
          } catch (err) {
            log.error(err);
            Honeybadger.notify(err);
          }
          res.send(201, user);
          mails.sendWelcomeMail(user, box);
        });
    })
    .then(function () {
      _postToSlack('Eine neue <https://opensensemap.org/explore/' + newBox._id + '|senseBox> wurde registriert (' + newBox.name + ')');
    })
    .catch(function (err) {
      log.error(err);
      return next(new restify.InvalidArgumentError(err.message + '. ' + err));
    });
}

// generate Arduino script
function genScript (box, model) {
  var output = cfg.targetFolder + '' + box._id + '.ino';
  // remove old script it it exists
  try {
    if (fs.statSync(output)) {
      fs.unlinkSync(output);
      console.log('deleted old sketch. (' + output + ') bye bye!');
    }
  } catch (e) {
    // don't notify honeybadger on ENOENT. The file isn't there if the script is first generated..
    if (e.code !== 'ENOENT') {
      Honeybadger.notify(e);
    }
  }

  var isCustom = false;
  var filename;
  switch (model) {
  case 'homeEthernet':
    filename = 'files/template_home/template_home.ino';
    break;
  case 'basicEthernet':
    filename = 'files/template_basic/template_basic.ino';
    break;
  case 'homeWifi':
    filename = 'files/template_home_wifi/template_home_wifi.ino';
    break;
  default:
    isCustom = true;
    filename = 'files/template_custom_setup/template_custom_setup.ino';
    break;
  }

  fs.readFileSync(filename)
    .toString()
    .split('\n')
    .forEach(function (line) {
      if (line.indexOf('//senseBox ID') !== -1) {
        fs.appendFileSync(output, line.toString() + '\n');
        fs.appendFileSync(output, '#define SENSEBOX_ID "' + box._id + '"\n');
      } else if (line.indexOf('//Sensor IDs') !== -1) {
        fs.appendFileSync(output, line.toString() + '\n');
        var customSensorindex = 1;
        for (var i = box.sensors.length - 1; i >= 0; i--) {
          var sensor = box.sensors[i];
          log.debug(sensor);
          if (!isCustom && sensor.title === 'Temperatur') {
            fs.appendFileSync(output, '#define TEMPSENSOR_ID "' + sensor._id + '"\n');
          } else if (!isCustom && sensor.title === 'rel. Luftfeuchte') {
            fs.appendFileSync(output, '#define HUMISENSOR_ID "' + sensor._id + '"\n');
          } else if (!isCustom && sensor.title === 'Luftdruck') {
            fs.appendFileSync(output, '#define PRESSURESENSOR_ID "' + sensor._id + '"\n');
          } else if (!isCustom && sensor.title === 'Lautstärke') {
            fs.appendFileSync(output, '#define NOISESENSOR_ID "' + sensor._id + '"\n');
          } else if (!isCustom && sensor.title === 'Helligkeit') {
            fs.appendFileSync(output, '#define LIGHTSENSOR_ID "' + sensor._id + '"\n');
          } else if (!isCustom && sensor.title === 'Beleuchtungsstärke') {
            fs.appendFileSync(output, '#define LUXSENSOR_ID "' + sensor._id + '"\n');
          } else if (!isCustom && sensor.title === 'UV-Intensität') {
            fs.appendFileSync(output, '#define UVSENSOR_ID "' + sensor._id + '"\n');
          } else {
            fs.appendFileSync(output, '#define SENSOR' + customSensorindex + '_ID "' + sensor._id + '" \/\/ ' + sensor.title + '\n');
            customSensorindex++;
          }
        }
      } else if (line.indexOf('@@OSEM_POST_DOMAIN@@') !== -1) {
        var newLine = line.toString().replace('@@OSEM_POST_DOMAIN@@', cfg.measurements_post_domain);
        fs.appendFileSync(output, newLine + '\n');
      } else {
        fs.appendFileSync(output, line.toString() + '\n');
      }
    });
}

/**
 * @api {get} /boxes/:senseBoxId/script Download the Arduino script for your senseBox
 * @apiName getScript
 * @apiGroup Boxes
 * @apiVersion 0.1.0
 * @apiUse AuthorizationRequiredError
 * @apiUse BoxIdParam
 */
function getScript (req, res, next) {
  Box.findById(req.boxId)
    .then(function (box) {
      var file = cfg.targetFolder + '' + box._id + '.ino';

      if (!fs.existsSync(file)) {
        genScript(box, box.model);
      }

      return res.send(200, fs.readFileSync(file, 'utf-8'));
    })
    .catch(function (err) {
      Honeybadger.notify(err);
      return next(new restify.NotFoundError(err.message));
    });
}

/**
 * @api {delete} /boxes/:senseBoxId Delete a senseBox and its measurements
 * @apiName deleteBox
 * @apiGroup Boxes
 * @apiVersion 0.1.0
 * @apiUse AuthorizationRequiredError
 * @apiUse BoxIdParam
 */
function deleteBox (req, res, next) {
  Box.deleteBox(req.boxId)
    .then(function () {
      res.send(200, 'Box deleted');
    }).catch(function (err) {
      Honeybadger.notify(err);
      return next(new restify.InternalServerError(err.message));
    });
}

/**
 * @api {get} /stats Get some statistics about the database
 * @apiDescription 8 boxes, 13 measurements in the database, 2 measurements in the last minute
 * @apiName getStatistics
 * @apiGroup Misc
 * @apiVersion 0.1.0
 * @apiSuccessExample {json}
 * [8,13, 2]
 */
function getStatistics (req, res) {
  var qrys = [
    Box.count({}),
    Measurement.count({}),
    Measurement.count({
      createdAt: {
        '$gt': new Date(Date.now() - 60000),
        '$lt': new Date()
      }
    })
  ];
  Promise.all(qrys).then(function (results) {
    res.send(200, results);
  });
}

function _postToSlack (text) {
  if (cfg.slack_url) {
    request.post({ url: cfg.slack_url, json: { text: text }});
  }
}

var stats = fs.statSync('./app.js');
var mtime = new Date(util.inspect(stats.mtime));

utils.connectWithRetry(function () {
  server.listen(cfg.port, function () {
    console.log('server file modified:', mtime);
    console.log('%s listening at %s', server.name, server.url);
    _postToSlack('openSenseMap API started. Server file modified: ' + mtime);
    Box.connectMQTTBoxes();
  });
});

server.on('uncaughtException', function (req, res, route, err) {
  Honeybadger.notify(err);
  log.error('Uncaught error', err);
  console.log(err.stack);
  return res.send(500, 'An error occured');
});
