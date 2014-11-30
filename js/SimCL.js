"use strict";

var Q = require('q');
var util = require('./util.js');
var cljs = require('./cl.js');
var _ = require('underscore');
var debug = require("debug")("N-body:SimCL");


var forceAtlas = require('./forceatlas.js'),
    gaussSeidel = require('./gaussseidel.js'),
    edgeBundling = require('./edgebundling.js'),
    barnesHut = require('./BarnesHut.js');


//var layoutAlgorithms = [gaussSeidel, edgeBundling, barnesHut];
var layoutAlgorithms = [barnesHut, gaussSeidel, edgeBundling];
//var layoutAlgorithms = [forceAtlas, gaussSeidel, edgeBundling];


if (typeof(window) == 'undefined') {
    var webcl = require('node-webcl');
} else if (typeof(webcl) == 'undefined') {
    var webcl = window.webcl;
}


Q.longStackSupport = true;
var randLength = 73;

function create(renderer, dimensions, numSplits, locked) {
    return cljs.create(renderer)
    .then(function(cl) {
        debug("Creating CL object with GL context");

        var kernelNames =
            _.chain(layoutAlgorithms)
                .pluck('kernelNames')
                .flatten()
                .value();

        // Compile the WebCL kernels
        return util.getSource("apply-forces.cl")
        .then(function(source) {
            debug("CL kernel source retrieved");
            return cl.compile(source, kernelNames);
        })
        .then(function(kernels) {
            console.log(kernelNames);
            debug("Compiled kernel source");
            var simObj = {
                renderer: renderer,
                cl: cl,
                elementsPerPoint: 2,
                kernels: kernels,
                versions: {
                    tick: 0,
                    buffers: { }
                }
            };
            simObj.tick = tick.bind(this, simObj);
            simObj.setPoints = setPoints.bind(this, simObj);
            simObj.setEdges = setEdges.bind(this, simObj);
            simObj.setLocked = setLocked.bind(this, simObj);
            simObj.setPhysics = setPhysics.bind(this, simObj);
            simObj.resetBuffers = resetBuffers.bind(this, simObj);
            simObj.setupTempBuffers = setupTempBuffers.bind(this, simObj);
            simObj.tickBuffers = tickBuffers.bind(this, simObj);

            simObj.dimensions = dimensions;
            simObj.numSplits = numSplits;
            simObj.numPoints = 0;
            simObj.numEdges = 0;
            simObj.numForwardsWorkItems = 0;
            simObj.numBackwardsWorkItems = 0;
            simObj.numMidPoints = 0;
            simObj.numMidEdges = 0;
            simObj.locked = _.extend(
                {lockPoints: false, lockMidpoints: true, lockEdges: false, lockMidedges: true},
                (locked || {})
            );
            simObj.physics = {};

            simObj.barnes = {
                
                num_nodes : 0,

                flag: 0,

                num_bodies : 0,


                buffers : {
                  x_cords: null, //cl.createBuffer(cl, 0, "x_cords"),
                  y_cords: null,
                  velx: null,
                  vely: null,
                  accx: null,
                  accy: null,
                  children: null,
                  global_x_mins: null,
                  global_y_mins: null,
                  global_x_maxs: null,
                  global_y_maxs: null,
                  count: null,
                  blocked: null,
                  step: null,
                  bottom: null,
                  maxdepth: null,
                }
            }

            simObj.buffers = {
                nextPoints: null,
                randValues: null,
                curPoints: null,
                forwardsEdges: null,
                forwardsDegrees: null,
                forwardsWorkItems: null,
                backwardsEdges: null,
                backwardsDegrees: null,
                backwardsWorkItems: null,
                springsPos: null,
                midSpringsPos: null,
                midSpringsColorCoord: null,
                nextMidPoints: null,
                curMidPoints: null
            };
            //constant
            simObj.buffersLocal = {
                pointSizes: null,
                pointColors: null
            };
            Object.seal(simObj.buffers);

            debug("WebCL simulator created");
            Object.seal(simObj);
            return simObj
        }, function (err) {
            console.error('Could not compile sim', err)
        });
    })

}


/**
 * Simulator * [ String ] * ?int -> ()
 * Increase buffer version to tick number, signifying its contents may have changed
 * (Same version number signifies no change since last read of that buffer)
 * If not tick provided, increment global and use that
 **/

var tickBuffers = function (simulator, bufferNames, tick) {

    if (tick === undefined) {
        simulator.versions.tick++;
        tick = simulator.versions.tick;
    }

    if (bufferNames.length) {
        bufferNames.forEach(function (name) {
            simulator.versions.buffers[name] = simulator.versions.tick;
       })
    }

};


/**
 * Given an array of (potentially null) buffers, delete the non-null buffers and set their
 * variable in the simulator buffer object to null.
 * NOTE: erase from host immediately, though device may take longer (unobservable)
 */
var resetBuffers = function(simulator, buffers) {

    if (!buffers.length) {
        return;
    }

    var buffNames = buffers
        .filter(function(val) { return !(!val); })
        .map(function (buffer) {
            for(var buff in simulator.buffers) {
                if(simulator.buffers.hasOwnProperty(buff) && simulator.buffers[buff] == buffer) {
                    return buff;
                }
            }
            throw new Error("Could not find buffer", buffer);
        });

    tickBuffers(simulator, buffNames);

    //delete old
    buffNames.forEach(function(buffName) {
        simulator.buffers[buffName].delete();
        simulator.buffers[buffName] = null;
    });
};


// TODO (paden) Do we need to allocate memory for these buffers on the host?
var setupTempBuffers = function(simulator) {
    simulator.resetBuffers(simulator.barnes.buffers);
    simulator.renderer.numPoints = simulator.numPoints;
    var blocks = 8; //TODO (paden) should be set to multiprocecessor count

    var num_nodes = simulator.numPoints * 4;
    // TODO (paden) make this into a definition
    var WARPSIZE = 16;
    //if (num_nodes < 1024*blocks) num_nodes = 1024*blocks;
    //while ((num_nodes & (WARPSIZE - 1)) != 0) num_nodes++;
    //num_nodes--;
    var num_bodies = simulator.numPoints;
    simulator.barnes.num_nodes = num_nodes;
    simulator.barnes.num_bodies = num_bodies;
    // TODO (paden) Use actual number of workgroups. Don't hardcode
    var num_work_groups = 100;
    
    //var blocked = new Int32Array(1);
    //blocked[0] = 0;
    //var step = new Int32Array(1);
    //step[0] = -1;
    //var max_depth = new Int32Array(1);
    //max_depth[0] = -1;
    //console.log("num_nodes: " + num_nodes);

    return Q.all(
        [
        simulator.cl.createBuffer((num_nodes + 1)*Float32Array.BYTES_PER_ELEMENT,  'x_cords'),
        simulator.cl.createBuffer((num_nodes + 1)*Float32Array.BYTES_PER_ELEMENT, 'y_cords'),
        simulator.cl.createBuffer((num_nodes + 1)*Float32Array.BYTES_PER_ELEMENT, 'accx'),
        simulator.cl.createBuffer((num_nodes + 1)*Float32Array.BYTES_PER_ELEMENT, 'accy'),
        simulator.cl.createBuffer(4*(num_nodes + 1)*Int32Array.BYTES_PER_ELEMENT, 'children'),
        simulator.cl.createBuffer((num_nodes + 1)*Float32Array.BYTES_PER_ELEMENT, 'mass'),
        simulator.cl.createBuffer((num_nodes + 1)*Int32Array.BYTES_PER_ELEMENT, 'start'),
        // TODO (paden) Create subBuffers
        simulator.cl.createBuffer((num_nodes + 1)*Int32Array.BYTES_PER_ELEMENT, 'sort'),
        simulator.cl.createBuffer((num_work_groups)*Float32Array.BYTES_PER_ELEMENT, 'global_x_mins'),
        simulator.cl.createBuffer((num_work_groups)*Float32Array.BYTES_PER_ELEMENT, 'global_x_maxs'),
        simulator.cl.createBuffer((num_work_groups)*Float32Array.BYTES_PER_ELEMENT, 'global_y_mins'),
        simulator.cl.createBuffer((num_work_groups)*Float32Array.BYTES_PER_ELEMENT, 'global_y_maxs'),
        simulator.cl.createBuffer((num_nodes + 1)*Int32Array.BYTES_PER_ELEMENT, 'count'),
        simulator.cl.createBuffer(Int32Array.BYTES_PER_ELEMENT, 'blocked'),
        simulator.cl.createBuffer(Int32Array.BYTES_PER_ELEMENT, 'step'),
        simulator.cl.createBuffer(Int32Array.BYTES_PER_ELEMENT, 'bottom'),
        simulator.cl.createBuffer(Int32Array.BYTES_PER_ELEMENT, 'maxdepth'),
        simulator.cl.createBuffer(Float32Array.BYTES_PER_ELEMENT, 'radius')
        ])
    .spread(function (x_cords, y_cords, accx, accy, children, mass, start, sort, xmin, xmax, ymin, ymax, count,
          blocked, step, bottom, maxdepth, radius) {
      simulator.barnes.buffers.x_cords = x_cords;
      simulator.barnes.buffers.y_cords = y_cords;
      simulator.barnes.buffers.accx = accx;
      simulator.barnes.buffers.accy = accy;
      simulator.barnes.buffers.children = children;
      simulator.barnes.buffers.mass = mass;
      simulator.barnes.buffers.start = start;
      simulator.barnes.buffers.sort = sort;
      simulator.barnes.buffers.xmin = xmin;
      simulator.barnes.buffers.xmax = xmax;
      simulator.barnes.buffers.ymin = ymin;
      simulator.barnes.buffers.ymax = ymax;
      simulator.barnes.buffers.count = count;
      simulator.barnes.buffers.blocked = blocked;
      simulator.barnes.buffers.step = step;
      simulator.barnes.buffers.bottom = bottom;
      simulator.barnes.buffers.maxdepth = maxdepth;
      simulator.barnes.buffers.radius = radius;
    })
    .catch(function(error) {

      console.log(error);
      console.log("ERROR in setUP");
    });
};



/**
 * Set the initial positions of the points in the NBody simulation (curPoints)
 * @param simulator - the simulator object created by SimCL.create()
 * @param {Float32Array} points - a typed array containing two elements for every point, the x
 * position, proceeded by the y position
 *
 * @returns a promise fulfilled by with the given simulator object
 */
function setPoints(simulator, points, pointSizes, pointColors) {
    if(points.length < 1) {
        throw new Error("The points buffer is empty");
    }
    if(points.length % simulator.elementsPerPoint !== 0) {
        throw new Error("The points buffer is an invalid size (must be a multiple of " + simulator.elementsPerPoint + ")");
    }

    if (!pointSizes) {
        pointSizes = new Uint8Array(points.length/simulator.elementsPerPoint);
        for (var i = 0; i < points.length/simulator.elementsPerPoint; i++) {
            pointSizes[i] = 4;
        }
    }

    if (!pointColors) {
        pointColors = new Uint32Array(points.length/simulator.elementsPerPoint);
        for (var i = 0; i < points.length/simulator.elementsPerPoint; i++) {
            pointColors[i] = (255 << 24) | (102 << 16) | (102 << 8) | 255;
        }
    }

    simulator.buffersLocal.pointSizes = pointSizes;
    simulator.buffersLocal.pointColors = pointColors;

    simulator.resetBuffers([
        simulator.buffers.nextPoints,
        simulator.buffers.randValues,
        simulator.buffers.curPoints,
        simulator.buffers.pointSizes,
        simulator.buffers.pointColors,
        // TODO (paden) Do we need to reset temp buffers? 
        ])

    simulator.numPoints = points.length / simulator.elementsPerPoint;
    simulator.renderer.numPoints = simulator.numPoints;

    debug("Number of points in simulation: %d", simulator.renderer.numPoints);

    // Create buffers and write initial data to them, then set
    simulator.tickBuffers(['curPoints', 'pointSizes', 'pointColors', 'randValues']);

    return Q.all([
        simulator.renderer.createBuffer(points, 'curPoints'),
        simulator.renderer.createBuffer(pointSizes, 'pointSizes'),
        simulator.renderer.createBuffer(pointColors, 'pointColors'),
        simulator.cl.createBuffer(points.byteLength, 'nextPoints'),
        simulator.cl.createBuffer(randLength * simulator.elementsPerPoint * Float32Array.BYTES_PER_ELEMENT,
            'randValues')])
    .spread(function(pointsVBO, pointSizesVBO, pointColorsVBO, nextPointsBuffer, randBuffer) {
        debug('Created most of the points');
        simulator.buffers.nextPoints = nextPointsBuffer;

        simulator.renderer.buffers.curPoints = pointsVBO;
        simulator.renderer.buffers.pointSizes = pointSizesVBO;
        simulator.renderer.buffers.pointColors = pointColorsVBO;

        // Generate an array of random values we will write to the randValues buffer
        simulator.buffers.randValues = randBuffer;
        var rands = new Float32Array(randLength * simulator.elementsPerPoint);
        for(var i = 0; i < rands.length; i++) {
            rands[i] = Math.random();
        }

        return Q.all([
            simulator.cl.createBufferGL(pointsVBO, 'curPoints'),
            simulator.buffers.randValues.write(rands)]);
    })
    .spread(function(pointsBuf, randValues) {
        simulator.buffers.curPoints = pointsBuf;
    })
    .then(gaussSeidel.setPoints.bind('', simulator))
    .then(forceAtlas.setPoints.bind('', simulator))
    .then(edgeBundling.setPoints.bind('', simulator))
    .then(function () {
        return simulator;
    });
}


/**
 * Sets the edge list for the graph
 *
 * @param simulator - the simulator object to set the edges for
 * @param {edgesTyped: {Uint32Array}, numWorkItems: uint, workItemsTyped: {Uint32Array} } forwardsEdges -
 *        Edge list as represented in input graph.
 *        edgesTyped is buffer where every two items contain the index of the source
 *        node for an edge, and the index of the target node of the edge.
 *        workItems is a buffer where every two items encode information needed by
 *         one thread: the index of the first edge it should process, and the number of
 *         consecutive edges it should process in total.
 * @param {edgesTyped: {Uint32Array}, numWorkItems: uint, workItemsTypes: {Uint32Array} } backwardsEdges -
 *        Same as forwardsEdges, except reverse edge src/dst and redefine workItems/numWorkItems corresondingly.
 * @param {Float32Array} midPoints - dense array of control points (packed sequence of nDim structs)
 * @param {Uint32Array} edgeColors - dense array of edge start and end colors
 * @returns {Q.promise} a promise for the simulator object
 */
function setEdges(simulator, forwardsEdges, backwardsEdges, midPoints, edgeColors) {
    //edges, workItems
    var elementsPerEdge = 2; // The number of elements in the edges buffer per spring
    var elementsPerWorkItem = 2;

    if(forwardsEdges.edgesTyped.length < 1) {
        throw new Error("The edge buffer is empty");
    }
    if(forwardsEdges.edgesTyped.length % elementsPerEdge !== 0) {
        throw new Error("The edge buffer size is invalid (must be a multiple of " + elementsPerEdge + ")");
    }
    if(forwardsEdges.workItemsTyped.length < 1) {
        throw new Error("The work items buffer is empty");
    }
    if(forwardsEdges.workItemsTyped.length % elementsPerWorkItem !== 0) {
        throw new Error("The work item buffer size is invalid (must be a multiple of " + elementsPerWorkItem + ")");
    }

    if (!edgeColors) {
        edgeColors = new Uint32Array(forwardsEdges.edgesTyped.length);
        for (var i = 0; i < edgeColors.length; i++) {
            var nodeIdx = forwardsEdges.edgesTyped[i];
            edgeColors[i] = simulator.buffersLocal.pointColors[nodeIdx];
        }
    }
    simulator.tickBuffers(['edgeColors']);
    simulator.buffersLocal.edgeColors = edgeColors;

    simulator.resetBuffers([
        simulator.buffers.forwardsEdges,
        simulator.buffers.forwardsDegrees,
        simulator.buffers.forwardsWorkItems,
        simulator.buffers.backwardsEdges,
        simulator.buffers.backwardsDegrees,
        simulator.buffers.backwardsWorkItems,
        simulator.buffers.springsPos,
        simulator.buffers.midSpringsPos,
        simulator.buffers.midSpringsColorCoord]);

    return Q().then(function() {
        // Init constant
        simulator.numEdges = forwardsEdges.edgesTyped.length / elementsPerEdge;
        debug("Number of edges in simulation: %d", simulator.numEdges);

        simulator.renderer.numEdges = simulator.numEdges;
        simulator.numForwardsWorkItems = forwardsEdges.workItemsTyped.length / elementsPerWorkItem;
        simulator.numBackwardsWorkItems = backwardsEdges.workItemsTyped.length / elementsPerWorkItem;

        simulator.numMidPoints = midPoints.length / simulator.elementsPerPoint;
        simulator.renderer.numMidPoints = simulator.numMidPoints;
        simulator.numMidEdges = simulator.numMidPoints + simulator.numEdges;
        simulator.renderer.numMidEdges = simulator.numMidEdges;

        // Create buffers
        return Q.all([
            simulator.cl.createBuffer(forwardsEdges.edgesTyped.byteLength, 'forwardsEdges'),
            simulator.cl.createBuffer(forwardsEdges.degreesTyped.byteLength, 'forwardsDegrees'),
            simulator.cl.createBuffer(forwardsEdges.workItemsTyped.byteLength, 'forwardsWorkItems'),
            simulator.cl.createBuffer(backwardsEdges.edgesTyped.byteLength, 'backwardsEdges'),
            simulator.cl.createBuffer(backwardsEdges.degreesTyped.byteLength, 'backwardsDegrees'),
            simulator.cl.createBuffer(backwardsEdges.workItemsTyped.byteLength, 'backwardsWorkItems'),
            simulator.cl.createBuffer(midPoints.byteLength, 'nextMidPoints'),
            simulator.renderer.createBuffer(simulator.numEdges * elementsPerEdge * simulator.elementsPerPoint * Float32Array.BYTES_PER_ELEMENT, 'springs'),
            simulator.renderer.createBuffer(midPoints, 'curMidPoints'),
            simulator.renderer.createBuffer(simulator.numMidEdges * elementsPerEdge * simulator.elementsPerPoint * Float32Array.BYTES_PER_ELEMENT, 'midSprings'),
            simulator.renderer.createBuffer(simulator.numMidEdges * elementsPerEdge * simulator.elementsPerPoint * Float32Array.BYTES_PER_ELEMENT, 'midSpringsColorCoord')]);
    })
    .spread(function(forwardsEdgesBuffer, forwardsDegreesBuffer, forwardsWorkItemsBuffer,
                     backwardsEdgesBuffer, backwardsDegreesBuffer, backwardsWorkItemsBuffer,
                     nextMidPointsBuffer, springsVBO,
                     midPointsVBO, midSpringsVBO, midSpringsColorCoordVBO) {
        // Bind buffers
        simulator.buffers.forwardsEdges = forwardsEdgesBuffer;
        simulator.buffers.forwardsDegrees = forwardsDegreesBuffer;
        simulator.buffers.forwardsWorkItems = forwardsWorkItemsBuffer;
        simulator.buffers.backwardsEdges = backwardsEdgesBuffer;
        simulator.buffers.backwardsDegrees = backwardsDegreesBuffer;
        simulator.buffers.backwardsWorkItems = backwardsWorkItemsBuffer;
        simulator.buffers.nextMidPoints = nextMidPointsBuffer;

        simulator.renderer.buffers.springs = springsVBO;
        simulator.renderer.buffers.curMidPoints = midPointsVBO;
        simulator.renderer.buffers.midSprings = midSpringsVBO;
        simulator.renderer.buffers.midSpringsColorCoord = midSpringsColorCoordVBO;

        return Q.all([
            simulator.cl.createBufferGL(springsVBO, 'springsPos'),
            simulator.cl.createBufferGL(midPointsVBO, 'curMidPoints'),
            simulator.cl.createBufferGL(midSpringsVBO, 'midSpringsPos'),
            simulator.cl.createBufferGL(midSpringsColorCoordVBO, 'midSpringsColorCoord'),
            simulator.buffers.forwardsEdges.write(forwardsEdges.edgesTyped),
            simulator.buffers.forwardsDegrees.write(forwardsEdges.degreesTyped),
            simulator.buffers.forwardsWorkItems.write(forwardsEdges.workItemsTyped),
            simulator.buffers.backwardsEdges.write(backwardsEdges.edgesTyped),
            simulator.buffers.backwardsDegrees.write(backwardsEdges.degreesTyped),
            simulator.buffers.backwardsWorkItems.write(backwardsEdges.workItemsTyped),
        ]);
    })
    .spread(function(springsBuffer, midPointsBuf, midSpringsBuffer, midSpringsColorCoordBuffer) {
        simulator.buffers.springsPos = springsBuffer;
        simulator.buffers.midSpringsPos = midSpringsBuffer;
        simulator.buffers.curMidPoints = midPointsBuf;
        simulator.buffers.midSpringsColorCoord = midSpringsColorCoordBuffer;
    })
    .then(function () {
      setupTempBuffers(simulator);
    })
    .then( function () {
        return Q.all(
            layoutAlgorithms
                .map(function (alg) {
                    return alg.setEdges(simulator);
                }));
    })
    .then(function () {
        return simulator;
    })
    .then(_.identity, function (err) {
        console.error('bad set edges', err);
        console.error(err.stack);
    });
}


function setLocked(simulator, cfg) {
    _.extend(simulator.locked, cfg || {});
}



function setPhysics(simulator, cfg) {
    // TODO: Instead of setting these kernel args immediately, we should make the physics values
    // properties of the simulator object, and just change those properties. Then, when we run
    // the kernels, we set the arg using the object property (the same way we set stepNumber.)

    cfg = cfg || {};
    for (var i in cfg) {
        simulator.physics[i] = cfg[i];
    }

    debug("Updating simulation physics to %o (new: %o)", simulator.physics, cfg);

    layoutAlgorithms.forEach(function (algorithm) {
        algorithm.setPhysics(simulator, cfg);
    });
}


//input positions: curPoints
//output positions: nextPoints
function tick(simulator, stepNumber) {

    // If there are no points in the graph, don't run the simulation
    if(simulator.numPoints < 1) {
        return Q(simulator);
    }

    simulator.versions.tick++;

    //run each algorithm to completion before calling next
    var tickAllHelper = function (remainingAlgorithms) {
        if (!remainingAlgorithms.length) return;
        var algorithm = remainingAlgorithms.shift();
        return Q()
            .then(function () {
                return algorithm.tick(simulator, stepNumber);
            })
            .then(function () {
                return tickAllHelper(remainingAlgorithms);
            });
    };

    var res = Q()
    .then(function () { return tickAllHelper(layoutAlgorithms.slice(0)); })
    .then(function() {
        // This cl.queue.finish() needs to be here because, without it, the queue appears to outside
        // code as running really fast, and tons of ticks will be called, flooding the GPU/CPU with
        // more stuff than they can handle.
        // What we really want here is to give finish() a callback and resolve the promise when it's
        // called, but node-webcl is out-of-date and doesn't support WebCL 1.0's optional callback
        // argument to finish().
        simulator.cl.queue.finish();
        simulator.renderer.finish();
    });

    res.then(function () {}, function (err) {
        console.error('tick fail!', err, (err||{}).stack);
    })

    return res;
}


module.exports = {
    "create": create,
    "setLocked": setLocked,
    "setPoints": setPoints,
    "setEdges": setEdges,
    "tick": tick
};
