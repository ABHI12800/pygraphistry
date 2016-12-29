'use strict';

import { Observable } from 'rxjs';

var urllib   = require('url');
var crypto   = require('crypto');
var _        = require('underscore');
var Q        = require('q');

var config   = require('@graphistry/config')();
var vgraph   = require('./vgraph.js');
var apiKey   = require('@graphistry/common').api;
var Cache    = require('@graphistry/common').cache;
var s3       = require('@graphistry/common').s3;
var Log      = require('@graphistry/common').logger;
var logger   = Log.createLogger('etlworker:etl1');

var tmpCache = new Cache(config.LOCAL_DATASET_CACHE_DIR, config.LOCAL_DATASET_CACHE);


// Convert JSON edgelist to VGraph then upload VGraph to S3 and local /tmp
// JSON
function etl(msg) {
    var name = decodeURIComponent(msg.name);
    logger.debug('ETL for', msg.name);

    var vg = vgraph.fromEdgeList(
        msg.graph,
        msg.labels,
        msg.bindings.sourceField,
        msg.bindings.destinationField,
        msg.bindings.idField,
        name
    );

    if (vg === undefined) {
        throw new Error('Invalid edgelist');
    }

    logger.info('VGraph created with', vg.vertexCount, 'nodes and', vg.edgeCount, 'edges');

    return publish(vg, name).then(function () {
        return {name: name, nodeCount: vg.vertexCount, edgeCount: vg.edgeCount};
    });
}


// VGraph * String -> Promise[String]
function publish(vg, name) {
    var metadata = {name: name};
    var binData = vg.encode().toBuffer();

    function cacheLocally() {
        // Wait a couple of seconds to make sure our cache has a
        // more recent timestamp than S3
        var res = Q.defer();
        setTimeout(function () {
            logger.debug('Caching dataset locally');
            res.resolve(tmpCache.put(urllib.parse(name), binData));
        }, 2000);
        return res.promise;
    }

    if (config.ENVIRONMENT === 'local') {
        logger.debug('Attempting to upload dataset');
        return s3Upload(binData, metadata)
            .fail(function (err) {
                logger.error(err, 'S3 Upload failed');
            }).then(cacheLocally, cacheLocally) // Cache locally regardless of result
            .then(_.constant(name)); // We succeed iff cacheLocally succeeds
    } else {
        // On prod/staging ETL fails if upload fails
        logger.debug('Uploading dataset');
        return cacheLocally()
            .then(function () { return s3Upload(binData, metadata) },
                  function () { return s3Upload(binData, metadata) })
            .then(_.constant(name))
            .fail(function (err) {
                logger.error(err, 'S3 Upload failed');
            });
    }
}


// Buffer * {name: String, ...} -> Promise
function s3Upload(binaryBuffer, metadata) {
    return s3.upload(config.S3, config.BUCKET, metadata, binaryBuffer, {ContentEncoding: 'gzip'});
}

export function processRequest(req, params) {
    return Observable.defer(() => {
        logger.info({ etlparams: params }, 'ETL1 request submitted');
        return Observable.fromPromise(etl(req.body));
    }).do((info) => {
        logger.info('ETL1 successful, dataset name is', info.name);
    });
}