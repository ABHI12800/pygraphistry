'use strict';

var _          = require('underscore'),
    Q          = require('q'),
    debug      = require('debug')('graphistry:graph-viz:cl:edgebundling'),
    cljs       = require('./cl.js'),
    util       = require('./util.js'),
    webcl      = require('node-webcl'),
    Kernel     = require('./kernel.js'),
    LayoutAlgo = require('./layoutAlgo.js'),
    EbBarnesKernelSeq = require('./javascript_kernels/ebBarnesKernelSeq.js');


function EdgeBundling(clContext) {
    LayoutAlgo.call(this, EdgeBundling.name);

    debug('Creating GaussSeidelBarnes kernels');
    this.ebBarnesKernelSeq = new EbBarnesKernelSeq(clContext);

    this.ebMidsprings = new Kernel('gaussSeidelMidsprings', EdgeBundling.argsMidsprings,
                                   EdgeBundling.argsType, 'edgeBundling.cl', clContext);

    this.kernels = this.kernels.concat([this.ebBarnesKernelSeq.toBarnesLayout, this.ebBarnesKernelSeq.boundBox,
                                        this.ebBarnesKernelSeq.buildTree, this.ebBarnesKernelSeq.computeSums,
                                        this.ebBarnesKernelSeq.sort, this.ebBarnesKernelSeq.calculateMidPoints,
                                        this.ebMidsprings]);
}
EdgeBundling.prototype = Object.create(LayoutAlgo.prototype);
EdgeBundling.prototype.constructor = EdgeBundling;

EdgeBundling.name = 'EdgeBundling';

EdgeBundling.argsMidsprings = ['numSplits', 'springs', 'workList', 'inputPoints',
                               'inputMidPoints', 'outputMidPoints', 'springMidPositions',
                               'midSpringsColorCoords', 'springStrength', 'springDistance',
                               'stepNumber'];

EdgeBundling.argsType = {
    numPoints: cljs.types.uint_t,
    numSplits: cljs.types.uint_t,
    inputMidPositions: null,
    outputMidPositions: null,
    tilePointsParam: cljs.types.local_t,
    width: cljs.types.float_t,
    height: cljs.types.float_t,
    charge: cljs.types.float_t,
    gravity: cljs.types.float_t,
    randValues: null,
    stepNumber: cljs.types.uint_t,
    springs: null,
    workList: null,
    inputPoints: null,
    inputMidPoints: null,
    outputMidPoints: null,
    springMidPositions: null,
    midSpringsColorCoords: null,
    springStrength: cljs.types.float_t,
    springDistance: cljs.types.float_t,
}

EdgeBundling.prototype.setPhysics = function(cfg) {
    LayoutAlgo.prototype.setPhysics.call(this, cfg)

    // get the flags from previous iteration
    var flags = this.ebBarnesKernelSeq.toBarnesLayout.get('flags');
    var flagNames = ['preventOverlap', 'strongGravity', 'dissuadeHubs', 'linLog'];
    _.each(cfg, function (val, flag) {
        var idx = flagNames.indexOf(flag);
        if (idx >= 0) {
            var mask = 0 | (1 << idx)
            if (val) {
                flags |= mask;
            } else {
                flags &= ~mask;
            }
        }
    });

    this.ebBarnesKernelSeq.setPhysics(flags);
    //this.edgeKernelSeq.setPhysics(flags);
}


// TODO (paden) This should be combined into barnesKernelsSeq
function getNumWorkitemsByHardware(deviceProps) {

    var numWorkGroups = {
        toBarnesLayout: [30, 256],
        boundBox: [30, 256],
        buildTree: [30, 256],
        computeSums: [10, 256],
        sort: [16, 256],
        edgeForces: [100, 256],
        segReduce: [1000, 256],
        calculateForces: [60, 256]
    }

    //console.log("DEVICE NAME: ", deviceProps.NAME);
    if (deviceProps.NAME.indexOf('GeForce GT 650M') != -1) {
        numWorkGroups.buildTree[0] = 1;
        numWorkGroups.computeSums[0] = 1;
    } else if (deviceProps.NAME.indexOf('Iris Pro') != -1) {
        numWorkGroups.computeSums[0] = 6;
        numWorkGroups.sort[0] = 8;
    } else if (deviceProps.NAME.indexOf('Iris') != -1) {
        numWorkGroups.computeSums[0] = 6;
        numWorkGroups.sort[0] = 8;
    } else if (deviceProps.NAME.indexOf('K520') != -1) {
        // 1024
        // 30:14.1, 36:14.3, 40:13.6, 46:14.5, 50:14.1, 60:14.1, 100:14.7,
        //
        // base 14.6% @ 200

        numWorkGroups.segReduce = [40, 1024];
        numWorkGroups.edgeForces = [200, 1024];

        // 1024
        // 6:35, 7:31, 8:27, 9:54, 10:50, 16:38, 20:52, 26:44
        // 30:41, 36:46
        //
        // 512
        // 2:92, 6:34, 7:29, 8:26, 9:44, 10:40, 14:31, 18:41, 24:35, 30:48
        numWorkGroups.buildTree = [8, 512];

        // 1024
        // 10:36, 14:27, 15:26, 16:24, 17:39, 18:38, 20:35, 26:28, 30:25, 36:30, 40:28, 46:25, 50:28, 60:25,
        // 70:26, 80:25, 100:26, 140:26, 200:26
        //
        // 512
        // 10:65, 20:35, 26:29, 28:27, 30:26, 34:39, 40:34
        numWorkGroups.calculateForces = [16, 1024];

        // 1024
        // 6:4, 8:4, 10:5,
        numWorkGroups.computeSums = [8, 1024];


    } else if (deviceProps.NAME.indexOf('HD Graphics 4000') != -1) {
        util.warn('Expected slow kernels: sort, calculate_forces');
    }

    return _.mapObject(numWorkGroups, function(val, key) {
        val[0] = val[0] * val[1];
        return val;
    });
}

// Contains any temporary buffers needed for layout
var tempLayoutBuffers  = {
  globalSpeed: null
};

// Create temporary buffers needed for layout
var setupTempLayoutBuffers = function(simulator) {
    return Q.all(
        [
        simulator.cl.createBuffer(Float32Array.BYTES_PER_ELEMENT, 'global_speed')
        ])
    .spread(function (globalSpeed) {
      tempLayoutBuffers.globalSpeed = globalSpeed;
      return tempLayoutBuffers;
    })
    .catch(util.makeErrorHandler('setupTempBuffers'));
};


EdgeBundling.prototype.setEdges = function (simulator) {
    var localPosSize =
        Math.min(simulator.cl.maxThreads, simulator.numMidPoints)
        * simulator.elementsPerPoint
        * Float32Array.BYTES_PER_ELEMENT;

    var global = simulator.controls.global;
    var that = this;
    var workGroupSize = 256;
    var workItems = getNumWorkitemsByHardware(simulator.cl.deviceProps, workGroupSize);
    return setupTempLayoutBuffers(simulator).then(function (tempBuffers) {
      that.ebBarnesKernelSeq.setMidPoints(simulator, tempBuffers, 32, workItems);

      that.ebMidsprings.set({
          numSplits: global.numSplits,
          springs: simulator.buffers.forwardsEdges.buffer,
          workList: simulator.buffers.forwardsWorkItems.buffer,
          inputPoints: simulator.buffers.curPoints.buffer,
          inputMidPoints: simulator.buffers.nextMidPoints.buffer,
          outputMidPoints: simulator.buffers.curMidPoints.buffer,
          springMidPositions: simulator.buffers.midSpringsPos.buffer,
          midSpringsColorCoords: simulator.buffers.midSpringsColorCoord.buffer
      });

    });
}

function midEdges(simulator, ebMidsprings, stepNumber) {
    var resources = [
        simulator.buffers.forwardsEdges,
        simulator.buffers.forwardsWorkItems,
        simulator.buffers.curPoints,
        simulator.buffers.nextMidPoints,
        simulator.buffers.curMidPoints,
        simulator.buffers.midSpringsPos,
        simulator.buffers.midSpringsColorCoord
    ];

    ebMidsprings.set({stepNumber: stepNumber});

    simulator.tickBuffers(['curMidPoints', 'midSpringsPos', 'midSpringsColorCoord']);

    debug('Running kernel gaussSeidelMidsprings')
    return ebMidsprings.exec([simulator.numForwardsWorkItems], resources);
}

EdgeBundling.prototype.tick = function(simulator, stepNumber) {
    var workGroupSize = 256;
    var workItems = getNumWorkitemsByHardware(simulator.cl.deviceProps, workGroupSize);
    var that = this;
    var locks = simulator.controls.locks;
    if (locks.lockMidpoints && locks.lockMidedges) {
        debug('LOCKED, EARLY EXIT');
        return Q();
    }

    return Q().then(function () {
        if (locks.lockMidpoints) {
            simulator.tickBuffers(['nextMidPoints']);
            return simulator.buffers.curMidPoints.copyInto(simulator.buffers.nextMidPoints);
        } else {
            return that.ebBarnesKernelSeq.execKernels(simulator, stepNumber, workItems);
        }
    }).then(function () { //TODO do both forwards and backwards?
        if (simulator.numEdges > 0 && !locks.lockMidedges) {
            return midEdges(simulator, that.ebMidsprings, stepNumber);
        } else {
            simulator.tickBuffers(['curMidPoints']);
            return simulator.buffers.nextMidPoints.copyInto(simulator.buffers.curMidPoints);
        }
    }).fail(util.makeErrorHandler('Failure in edgebundling tick'));
}

module.exports = EdgeBundling;
