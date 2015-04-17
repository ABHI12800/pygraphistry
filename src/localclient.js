'use strict';

/*
    Local-only facet for client.js
*/

var debug        = require('debug')('graphistry:StreamGL:localclient');
var $            = window.$;
var Rx           = require('rx');
                   require('./rx-jquery-stub');
var _            = require('underscore');

var renderer     = require('./renderer.js');


//======

//can get reset by basePath()
var BASE_PATH = '/graph/viz/facebook.';

//======


//string * {socketHost: string, socketPort: int} -> (... -> ...)
// where fragment == 'vbo?buffer' or 'texture?name'
function makeFetcher () {
//string * {<name> -> int} * name -> Subject ArrayBuffer
    return function (bufferByteLengths, bufferName) {

        debug('fetching', bufferName);

        var res = new Rx.Subject();

        //https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest/Sending_and_Receiving_Binary_Data?redirectlocale=en-US&redirectslug=DOM%2FXMLHttpRequest%2FSending_and_Receiving_Binary_Data
        var oReq = new XMLHttpRequest();
        oReq.open('GET', BASE_PATH + bufferName + '.vbo', true);
        oReq.responseType = 'arraybuffer';

        var now = Date.now();
        oReq.onload = function () {
            try {
                debug('got texture/vbo data', bufferName, Date.now() - now, 'ms');

                var arrayBuffer = oReq.response; // Note: not oReq.responseText
                var blength = bufferByteLengths[bufferName];
                debug('Buffer length (%s): %d, %d', bufferName, blength, arrayBuffer.byteLength);
                var trimmedArray = new Uint8Array(arrayBuffer, 0, blength);

                res.onNext(trimmedArray);

            } catch (e) {
                console.error('Render error on loading data into WebGL:', e, e.stack);
            }
        };

        oReq.send(null);

        return res.take(1);
    };
}






module.exports = {

    basePath: function (path) {
        BASE_PATH = path;
        return module.exports;
    },

    connect: function (vizType) {
        debug('connect', vizType);

        return Rx.Observable.return({
            socket: {
                on: function (evt) { debug('ignoring on reg', evt); },
                emit: function (evt) { debug('ignoring emit', evt); }
            },
            params: {}
        });
    },

    createRenderer: function (socket, canvas) {
        debug('createRenderer');

        return $.ajaxAsObservable({
                url: BASE_PATH + 'renderconfig.json',
                dataType: 'json'
            })
            .pluck('data')
            .map(function (data) {
                debug('got', data);
                return renderer.init(data, canvas);
            });
    },

    handleVboUpdates: function (socket, renderState) {
        debug('handle vbo updates');

        var vboUpdates = new Rx.BehaviorSubject('init');

        $.ajaxAsObservable({url: BASE_PATH + 'metadata.json', dataType: 'json'})
            .pluck('data')
            .do(function (data) {
                debug('got metadata', data);

                $('#graph-node-count').text(data.elements.pointculled);
                var numEdges = (data.elements.edgeculled || data.elements.edgeculledindexed ||
                                data.elements.edgeculledindexedclient) / 2;
                $('#graph-edge-count').text(numEdges);

                vboUpdates.onNext('start');

                var fetchBuffer = makeFetcher().bind('', data.bufferByteLengths);
                var fetchTexture = makeFetcher().bind('', data.bufferByteLengths);


                var readyBuffers = new Rx.ReplaySubject(1);
                var readyTextures = new Rx.ReplaySubject(1);
                var readyToRender = Rx.Observable.zip(readyBuffers, readyTextures, _.identity).share();
                readyToRender.subscribe(
                    function () { vboUpdates.onNext('received'); },
                    function (err) { console.error('readyToRender error', err, (err||{}).stack); });

                var changedBufferNames = _.keys(data.bufferByteLengths);
                var bufferVBOs = Rx.Observable.zipArray(
                    [Rx.Observable.return()]
                        .concat(changedBufferNames.map(fetchBuffer)))
                    .take(1);
                bufferVBOs
                    .subscribe(function (vbos) {
                            vbos.shift();
                            var bindings = _.object(_.zip(changedBufferNames, vbos));
                            try {
                                _.each(data.elements, function (num, itemName) {
                                    renderer.setNumElements(renderState, itemName, num);
                                });
                                renderer.loadBuffers(renderState, bindings);
                                readyBuffers.onNext();
                            } catch (e) {
                                console.error('Render error on loading data into WebGL:', e, e.stack);
                            }
                        },
                        function (err) {
                            console.error('bufferVBOs exn', err, (err||{}).stack);
                        });

                var changedTextureNames = [];
                var texturesData = Rx.Observable.zipArray(
                    [Rx.Observable.return()]
                        .concat(changedTextureNames.map(fetchTexture)))
                    .take(1);
                texturesData
                    .subscribe(function (textures) {
                            textures.shift();
                            var textureNfos = changedTextureNames.map(function (name, i) {
                                return _.extend(data.textures[name], {buffer: textures[i]});
                            });
                            var bindings = _.object(_.zip(changedTextureNames, textureNfos));
                            renderer.loadTextures(renderState, bindings);
                            readyTextures.onNext();
                        },
                        function (err) {
                                console.error('texturesData exn', err, (err||{}).stack);
                        });

            }).subscribe(_.identity,
                function (err) {
                    console.error('fetch vbo exn', err, (err||{}).stack);
                });

        return vboUpdates;

    }
};