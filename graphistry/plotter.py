import requests
import os

from graphistry.util import arrow_util, dict_util, graph as graph_util
from graphistry.constants import BINDING, BINDING_DEFAULT


class AssignableSettings(object):

    def __init__(self, defaults, settings = {}):
        self._defaults = defaults
        self._settings = settings


    def __iter__(self):
        for key in self._defaults:
            value = self.get(key)
            if value is not None:
                yield (key, value)


    def get(self, key, fallback_to_defaults=True):
        if fallback_to_defaults:
            return self._settings[key] if key in self._settings else self._defaults[key]
        else:
            return self._settings[key]


    def with_assignments(self, settings):
        return AssignableSettings(
            self._defaults,
            self._updates(settings)
        )


    def _updates(self, settings):

        missing_keys = set(settings.keys()) - set(self._defaults.keys())

        if len(missing_keys) > 0:
            raise KeyError("The following settings (keys) were not found: %s" % ', '.join(missing_keys))

        merged_settings = self._settings.copy()
        merged_settings.update(settings)

        return merged_settings


class Plotter(object):

    @staticmethod
    def update_default_settings(settings):
        Plotter.__default_settings.update(
            (key, value) for key, value in settings.items() if key in Plotter.__default_settings
        )

    __default_settings = {
        'protocol': 'https',
        'server': 'alpha.graphistry.com',
        'key': None,
        'certificate_validation': None,
        'bolt': None,
        'height': 600,
        'url_params': {},
        'render': True
    }

    __default_bindings = {
        # node : data
        BINDING.NODE_ID: BINDING_DEFAULT.NODE_ID,

        # edge : data
        BINDING.EDGE_ID: BINDING_DEFAULT.EDGE_ID,
        BINDING.EDGE_SRC: BINDING_DEFAULT.EDGE_SRC,
        BINDING.EDGE_DST: BINDING_DEFAULT.EDGE_DST,

        # node : visualization
        BINDING.NODE_TITLE: None,
        BINDING.NODE_LABEL: None,
        BINDING.NODE_COLOR: None,
        BINDING.NODE_SIZE: None,

        # edge : visualization
        BINDING.EDGE_TITLE: None,
        BINDING.EDGE_LABEL: None,
        BINDING.EDGE_COLOR: None,
        BINDING.EDGE_WEIGHT: None,
    }

    _data = {
        'nodes': None,
        'edges': None
    }

    _bindings_map = {
        BINDING.NODE_ID:     BINDING.NODE_ID,
        BINDING.NODE_COLOR:  BINDING.NODE_COLOR,
        BINDING.NODE_LABEL:  BINDING.NODE_LABEL,
        BINDING.NODE_TITLE:  BINDING.NODE_TITLE,
        BINDING.NODE_SIZE:   BINDING.NODE_SIZE,
        BINDING.EDGE_ID:     BINDING.EDGE_ID,
        BINDING.EDGE_SRC:    BINDING.EDGE_SRC,
        BINDING.EDGE_DST:    BINDING.EDGE_DST,
        BINDING.EDGE_COLOR:  BINDING.EDGE_COLOR,
        BINDING.EDGE_LABEL:  BINDING.EDGE_LABEL,
        BINDING.EDGE_TITLE:  BINDING.EDGE_TITLE,
        BINDING.EDGE_WEIGHT: BINDING.EDGE_WEIGHT,
    }

    _bindings = AssignableSettings(__default_bindings)
    _settings = AssignableSettings(__default_settings)

    def __init__(
        self,
        base=None,
        data=None,
        bindings=None,
        settings=None
    ):
        if base is None:
            base = self

        self._data     = data     or base._data
        self._bindings = bindings or base._bindings
        self._settings = settings or base._settings


    def data(self,  **data):
        if 'graph' in data:
            (edges, nodes) = graph_util.decompose(data['graph'])
            return self.data(
                edges=edges,
                nodes=nodes
            )

        if 'edges' in data:
            data['edges'] = arrow_util.to_arrow(data['edges'])

        if 'nodes' in data:
            data['nodes'] = arrow_util.to_arrow(data['nodes'])

        return Plotter(
            self,
            data=dict_util.assign(self._data, data)
        )


    def bind(self,  **bindings):
        return Plotter(
            self,
            bindings=self._bindings.with_assignments(bindings)
        )


    def settings(self, **settings):
        return Plotter(
            self,
            settings=self._settings.with_assignments(settings)
        )


    def nodes(self, nodes):
        return self.data(nodes=nodes)


    def edges(self, edges):
        return self.data(edges=edges)


    def graph(self, graph):
        return self.data(graph=graph)


    def plot(self, edgesOrGraph=None, render=None, skip_upload=False):
        # TODO(cwharris): verify required bindings

        if render is None:
            render = self._settings.get('render')

        edges=self._data['edges']
        nodes=self._data['nodes']

        if edgesOrGraph is not None:
            # is it a graph we support?
            try:
                (edges, nodes) = graph_util.decompose(edgesOrGraph)
            except TypeError:
                # if we don't support it as a graph, assume it's edges.
                edges = arrow_util.to_arrow(edgesOrGraph)

        (edges, nodes) = graph_util.rectify(
            edges=edges,
            nodes=nodes,
            edge=self._bindings.get(BINDING.EDGE_ID),
            node=self._bindings.get(BINDING.NODE_ID),
            edge_src=self._bindings.get(BINDING.EDGE_SRC),
            edge_dst=self._bindings.get(BINDING.EDGE_DST),
            safe=True
        )

        if skip_upload:
            return {
                'bindings': { key: value for (key, value) in self._bindings },
                'edges': edges,
                'nodes': nodes
            }

        nodeBuffer = arrow_util.table_to_buffer(nodes)
        edgeBuffer = arrow_util.table_to_buffer(edges)

        files = {
            'nodes': ('nodes', nodeBuffer.to_pybytes(), 'application/octet-stream'),
            'edges': ('edges', edgeBuffer.to_pybytes(), 'application/octet-stream')
        }

        data = {
            self._bindings_map[key]: self._bindings.get(key)
            for key in Plotter.__default_bindings.keys()
            if self._bindings.get(key) is not None
        }

        graphistry_uri = '%s://%s' % (self._settings.get('protocol'), self._settings.get('server'))
        
        response = requests.post(
            '%s/datasets' % graphistry_uri,
            files=files,
            data=data,
            timeout=(10, None) # TODO(cwharris): make 'connection' timeout configurable... maybe the 'read' timeout, too.
        )

        # TODO(cwharris): Try to present a friendly error message.

        response.raise_for_status()

        # TODO(cwharris): Transform in to appropriate return value (HTML, etc).

        jres = response.json()

        import calendar
        import time

        url_params = self._settings.get('url_params') or {}
        url_params = url_params.items()
        url_params = {
            k: v for k, v in url_params if v is not None
        }

        if 'workbook' in url_params:
            import warnings
            warnings.warn(
                'url parameter deprecated: "workbook"',
                DeprecationWarning
            )

        query_string = _url_encode(url_params)

        url = "%s/graph/graph.html?dataset=%s&splashAfter=%s&%s" % (
            graphistry_uri,
            jres['revisionId'],
            int(calendar.timegm(time.gmtime())) + 15,
            query_string
        )

        if render is not True:
            return url

        if _in_ipython():
            from IPython.core.display import HTML
            iframe_html = _make_iframe(url, self._settings.get('height'))
            return HTML(iframe_html)

        import webbrowser
        webbrowser.open(url)
        return url

    def bolt(self, driver_or_config):
        return self.settings({
            'bolt': driver_or_config
        })

    def cypher(self, query, params={}):
        import neo4j

        driver = self._settings.get('bolt')

        if not isinstance(driver, neo4j.Driver):
            driver = neo4j.GraphDatabase.driver(**driver)

        with driver.session() as session:
            bolt_statement = session.run(query, **params)
            graph = bolt_statement.graph()
            return self.data(graph=graph)

def _url_encode(query_params):
    import sys
    import urllib

    if sys.version_info[0] < 3:
        return urllib.urlencode(query_params)

    return urllib.parse.urlencode(query_params)

def _in_ipython():
    try:
        __IPYTHON__
        return True
    except NameError:
        return False


def _make_iframe(raw_url, height):
    import uuid
    id = uuid.uuid4()

    scrollbug_workaround='''
            <script>
                $("#%s").bind('mousewheel', function(e) {
                e.preventDefault();
                });
            </script>
        ''' % id

    iframe = '''
            <iframe id="%s" src="%s"
                    allowfullscreen="true" webkitallowfullscreen="true" mozallowfullscreen="true"
                    oallowfullscreen="true" msallowfullscreen="true"
                    style="width:100%%; height:%dpx; border: 1px solid #DDD">
            </iframe>
        ''' % (id, raw_url, height)

    return iframe + scrollbug_workaround
