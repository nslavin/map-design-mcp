export const DEV_PATTERNS: Record<string, string> = {

scaffolding: `
MAPBOX GL JS SCAFFOLDING (v3.21.0 — current stable April 2026)

━━ STEP 0 — TOKEN (do this before writing a single line of map code) ━━━━━━━━
  1. Call list_tokens_tool() — find a token where note === 'figma-make'
  2a. Found + has all required scopes → use its token value as mapboxgl.accessToken
  2b. Not found OR scopes missing → call create_token_tool({
        note: 'figma-make',
        scopes: ['styles:tiles','styles:read','fonts:read','datasets:read']
      }) and use the returned pk.* value
  NEVER use a placeholder token. The Figma Make built-in token is EXPIRED.

━━ COMPLETE WORKING TEMPLATE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <!-- CSS MUST come before the script tag — controls are invisible without it -->
  <link href="https://api.mapbox.com/mapbox-gl-js/v3.21.0/mapbox-gl.css" rel="stylesheet">
  <script src="https://api.mapbox.com/mapbox-gl-js/v3.21.0/mapbox-gl.js"></script>
  <style>
    /* REQUIRED: body and #map must have explicit height — zero-height = invisible map */
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { width: 100vw; height: 100vh; }
    #map { width: 100%; height: 100%; }
  </style>
</head>
<body>
  <div id="map"></div>
  <script>
    mapboxgl.accessToken = 'PASTE_PK_TOKEN_HERE'  // from list_tokens_tool / create_token_tool
    const map = new mapboxgl.Map({
      container: 'map',
      style: 'mapbox://styles/mapbox/standard',
      center: [0, 20],
      zoom: 2,
      config: { basemap: { lightPreset: 'day' } }
    })
    map.on('error', e => console.error('Map error:', e.error))  // always add — silent failures are invisible
    map.on('load', () => {
      // ALL addSource() and addLayer() calls go HERE — never before 'load' fires
    })
  </script>
</body>
</html>

━━ WHY MAPS DON'T RENDER — top 5 root causes ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  1. EXPIRED TOKEN  → list_tokens_tool() first; create fresh figma-make token if needed
  2. ZERO-HEIGHT CONTAINER  → #map needs explicit height (100vh, 600px, etc); flex/grid parents too
  3. CSS NOT LOADED  → <link mapbox-gl.css> MUST be before <script mapbox-gl.js>
  4. ADDING LAYERS BEFORE 'load'  → ALL addSource/addLayer must be inside map.on('load', ...)
  5. DOUBLE INIT  → in React StrictMode, guard with: if (map.current) return

━━ STANDARD STYLE CONFIG ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  new mapboxgl.Map({ style: 'mapbox://styles/mapbox/standard',
    config: { basemap: {
      theme: 'monochrome',         // 'default'|'faded'|'monochrome'|'cool'|'warm'|'outdoors'|'winter'
      lightPreset: 'day',          // 'dawn'|'day'|'dusk'|'night'
      showPointOfInterestLabels: false,
      show3dBuildings: false,
    }}
  })
  // Runtime updates — NEVER call setStyle() for incremental changes:
  map.setConfigProperty('basemap', 'lightPreset', 'night')

━━ SLOT SYSTEM — required for custom layers on Standard ━━━━━━━━━━━━━━━━━━━━━
  slot: 'bottom'  — behind roads (raster overlays, terrain)
  slot: 'middle'  — above roads, below labels (polygon zones)
  slot: 'top'     — above everything (routes, markers, annotations)
  map.addLayer({ id: 'x', type: 'fill', source: 's', slot: 'top', paint: {...} })

━━ REACT ESSENTIALS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  import 'mapbox-gl/dist/mapbox-gl.css'             // REQUIRED — controls invisible without this
  mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN
  // Container MUST have explicit height — zero-height div = invisible map
  // Always return () => map.current?.remove() from the useEffect for cleanup
`,

pins_and_markers: `
PINS AND MARKERS:
Examples: /example/add-a-marker/ /example/custom-marker-icons/ /example/geojson-markers/

ICON ANCHOR CHEATSHEET:
  Push-pin / teardrop shape:  icon-anchor 'bottom'  (pin tip = coordinate)
  Circle / dot marker:        icon-anchor 'center'
  Rectangular badge:          icon-anchor 'center' + icon-text-fit 'both' + icon-text-fit-padding [4,8,4,8]

LABEL PLACEMENT — use the modern variable-anchor approach:
  MODERN (preferred): text-variable-anchor + text-radial-offset
    → renderer tries each anchor in order and picks the first non-colliding position
    → eliminates the "label on top of icon" bug at scale
  STATIC (simple single-icon maps only): text-anchor 'top' + text-offset [0, 1.25]
  NEVER: text-anchor 'center' with icon-image — label lands directly on the icon

< 100 → mapboxgl.Marker (HTML, full DOM control):
  new mapboxgl.Marker().setLngLat([12.55, 55.7]).addTo(map)
  new mapboxgl.Marker({ color:'#e63946', rotation:45 }).setLngLat([lng,lat]).addTo(map)
  // Custom element:
  const el = document.createElement('div')
  el.className = 'my-marker'  // style with CSS background-image
  new mapboxgl.Marker({ element:el }).setLngLat([lng,lat]).addTo(map)
  // NOTE: map.loadImage() accepts PNG/JPG/WebP only — NOT SVG directly

// BUILT-IN: For simple location pins, no loadImage needed:
//   'icon-image': 'marker'   ← Mapbox Standard ships this icon natively
//   Only 2 built-in icons exist in Standard: 'marker' and 'intersection'

100–1,000 → Symbol layer with MODERN label placement:
  map.loadImage('https://...icon.png', (err, image) => {
    if (err) throw err
    map.addImage('custom-icon', image)
    map.addSource('places', { type:'geojson', data:featureCollection })
    map.addLayer({
      id:'places', type:'symbol', source:'places', slot:'top',
      layout:{
        'icon-image': 'custom-icon',
        'icon-anchor': 'bottom',                    // push-pin tip at coordinate
        'icon-size': ['interpolate',['linear'],['zoom'], 10, 0.6, 15, 1.2],
        'text-field': ['get', 'name'],
        'text-size': 12,
        // Modern variable-anchor: renderer picks least-colliding position from list
        'text-variable-anchor': ['top','top-right','top-left','right','left'],
        'text-radial-offset': 1.5,                  // em units from icon edge
        'text-justify': 'auto',                     // pairs with variable-anchor
        'text-allow-overlap': false,
      },
      paint:{
        'text-color': '#111111',
        'text-halo-color': 'rgba(255,255,255,0.92)',
        'text-halo-width': 1.5,
      }
    })
  })

1,000+ → Clustered source (see clustering pattern)

CUSTOM SVG ICONS — quality rules:
  SVGs must be rasterized via canvas (map.loadImage does not accept SVG).
  Rasterization is done at 2× pixel ratio → 24px viewBox = 48px canvas = crisp 24px icon.
  viewBox: "0 0 24 24" — keep it 24×24 or 32×32 (power-of-2)
  Flat fill ONLY — no gradients, no feDropShadow/feGaussianBlur, no stroke on paths
  Max 3–4 <path> elements — GPU texture artifacts appear with complex paths
  Anti-patterns: gradient fills, stroke-based shapes, filter effects, icon-size as a flat number

Selected state:
  map.setFeatureState({ source:'places', id:featureId }, { selected:true })
  // paint: ['case',['boolean',['feature-state','selected'],false], selectedColor, defaultColor]

Draggable: new mapboxgl.Marker({ draggable:true }).on('dragend', () => marker.getLngLat())
Toggle:    marker.getElement().style.display = 'none'
Cursor:    map.on('mouseenter','places',()=>map.getCanvas().style.cursor='pointer')
           map.on('mouseleave','places',()=>map.getCanvas().style.cursor='')
`,

popups: `
POPUPS:
Examples: /example/popup/ /example/popup-on-click/ /example/popup-on-hover/

Static:
  new mapboxgl.Popup({ closeOnClick:false })
    .setLngLat([-96,37.8]).setHTML('<h1>Hello</h1>').addTo(map)

On layer click (v3 Interactions API — preferred):
  map.addInteraction('place-click', { type:'click', target:{ layerId:'places' },
    handler:(e) => {
      const coords = e.feature.geometry.coordinates.slice()
      while (Math.abs(e.lngLat.lng - coords[0]) > 180)  // antimeridian fix
        coords[0] += e.lngLat.lng > coords[0] ? 360 : -360
      new mapboxgl.Popup().setLngLat(coords)
        .setHTML('<b>'+e.feature.properties.name+'</b>').addTo(map)
    }
  })

On hover (single popup updated on mousemove):
  const popup = new mapboxgl.Popup({ closeButton:false, closeOnClick:false })
  map.on('mousemove','layer-id',(e)=>popup.setLngLat(e.lngLat).setHTML(e.features[0].properties.desc).addTo(map))
  map.on('mouseleave','layer-id',()=>popup.remove())

Attached to Marker:
  new mapboxgl.Marker().setLngLat([lng,lat])
    .setPopup(new mapboxgl.Popup({offset:25}).setHTML('<p>Content</p>')).addTo(map)

Polygon popup — use e.lngLat not feature coords:
  map.on('click','polygon-layer',(e)=>
    new mapboxgl.Popup().setLngLat(e.lngLat).setHTML(e.features[0].properties.name).addTo(map))
`,

routing_and_directions: `
ROUTING AND DIRECTIONS:
Examples: /example/mapbox-gl-directions/ /example/animate-point-along-route/

mapbox-gl-directions plugin (full UI with inputs + turn-by-turn):
  <script src="https://api.mapbox.com/mapbox-gl-js/plugins/mapbox-gl-directions/v4.3.1/mapbox-gl-directions.js"></script>
  <link href="https://api.mapbox.com/mapbox-gl-js/plugins/mapbox-gl-directions/v4.3.1/mapbox-gl-directions.css" rel="stylesheet">
  map.addControl(new MapboxDirections({
    accessToken:mapboxgl.accessToken, unit:'metric',
    profile:'mapbox/cycling'  // 'mapbox/driving'|'mapbox/walking'|'mapbox/cycling'
  }), 'top-left')

Raw Directions API (custom UI):
  const r = await fetch('https://api.mapbox.com/directions/v5/mapbox/driving/lng1,lat1;lng2,lat2?geometries=geojson&steps=true&access_token='+token)
  const route = (await r.json()).routes[0]

Draw route — ALWAYS slot:'top':
  map.addSource('route',{type:'geojson',data:{type:'Feature',geometry:route.geometry}})
  map.addLayer({id:'route',type:'line',source:'route',slot:'top',
    layout:{'line-join':'round','line-cap':'round'},
    paint:{'line-color':brandColor,'line-width':4,'line-opacity':0.85}})
  // 3D building occlusion: add 'line-occlusion-opacity':0.5

Fit to route:
  const bounds = new mapboxgl.LngLatBounds(route.geometry.coordinates[0], route.geometry.coordinates[0])
  route.geometry.coordinates.forEach(c=>bounds.extend(c))
  map.fitBounds(bounds,{padding:40})

Turn-by-turn: route.legs[0].steps — each has maneuver.instruction, distance, duration
Advance step when user within 20m of step.maneuver.location

Animate point along route:
  let counter=0; const arc=[]
  const dist = turf.length(turf.lineString([origin,destination]))
  for (let i=0;i<dist;i+=dist/500) arc.push(turf.along(routeFeature,i).geometry.coordinates)
  function animate(){
    point.features[0].geometry.coordinates=arc[counter]
    map.getSource('point').setData(point)
    if(counter<500) requestAnimationFrame(animate); counter++
  }

Multi-stop optimization (≤12 stops):
  GET /optimized-trips/v1/mapbox/driving/{coords}?geometries=geojson&access_token={token}
`,

search_and_geocoding: `
SEARCH AND GEOCODING:
Examples: /example/mapbox-gl-geocoder-outside-the-map/ /example/point-from-geocoder-result/

Interactive autocomplete → @mapbox/search-js-react (NOT raw Geocoding API):
  import { SearchBox } from '@mapbox/search-js-react'
  <SearchBox accessToken={token} onRetrieve={(res)=>flyToResult(res)} />
  Why: auto session tokens, built-in debounce, correct two-step suggestions/retrieve flow

mapbox-gl-geocoder plugin (adds search control to map):
  <script src="https://api.mapbox.com/mapbox-gl-js/plugins/mapbox-gl-geocoder/v5.1.0/mapbox-gl-geocoder.min.js"></script>
  <link href="https://api.mapbox.com/mapbox-gl-js/plugins/mapbox-gl-geocoder/v5.1.0/mapbox-gl-geocoder.css" rel="stylesheet">
  map.addControl(new MapboxGeocoder({
    accessToken:mapboxgl.accessToken, mapboxgl:mapboxgl, marker:false,
    bbox:[sw_lng,sw_lat,ne_lng,ne_lat], countries:'fi', language:'fi',
    localGeocoder: query => customFeatures.filter(f=>f.properties.name.includes(query)),
    render: item => '<div>'+item.place_name+'</div>',
  }))

Geocoder outside map (sidebar):
  const geocoder = new MapboxGeocoder({accessToken,mapboxgl})
  geocoder.addTo('#sidebar-div')
  geocoder.on('result', e=>map.flyTo({center:e.result.center,zoom:14}))

Fly to result: map.flyTo({center:result.geometry.coordinates,zoom:14})
  // With bbox: map.fitBounds(result.bbox,{padding:40})

Reverse geocode on click:
  map.on('click', async e=>{
    const res=await fetch('/search/geocode/v6/reverse?longitude='+e.lngLat.lng+'&latitude='+e.lngLat.lat+'&access_token='+token)
    const data=await res.json()
    new mapboxgl.Popup().setLngLat(e.lngLat).setHTML(data.features[0].place_name).addTo(map)
  })
`,

map_interaction: `
MAP INTERACTION:
Examples: /example/simple-interactions/ /example/queryrenderedfeatures/ /example/drag-a-point/

v3 Interactions API (preferred):
  map.addInteraction('hover', {type:'mouseenter',target:{layerId:'airports'},
    handler:({feature})=>{map.setFeatureState(feature,{highlight:true});map.getCanvas().style.cursor='pointer'}})
  map.addInteraction('unhover',{type:'mouseleave',target:{layerId:'airports'},
    handler:({feature})=>map.setFeatureState(feature,{highlight:false})})
  map.addInteraction('click',{type:'click',target:{layerId:'airports'},
    handler:({feature})=>setSelected(feature)})
  // paint: ['case',['boolean',['feature-state','highlight'],false],'#ff0','#888']

Classic events (still works):
  map.on('click','layer-id',(e)=>{ /* e.features[0] */ })

queryRenderedFeatures:
  const features = map.queryRenderedFeatures(e.point, {layers:['my-layer']})

Drag a point:
  map.on('mousedown','point',(e)=>{
    e.preventDefault(); map.dragPan.disable()
    map.on('mousemove',onMove)
    map.once('mouseup',()=>{map.dragPan.enable();map.off('mousemove',onMove)})
  })
  function onMove(e){map.getSource('pt').setData({type:'Feature',geometry:{type:'Point',coordinates:[e.lngLat.lng,e.lngLat.lat]}})}

Toggle handlers: map.scrollZoom.disable()/.enable(), map.dragPan.disable()/.enable()

Viewport list sync (moveend):
  map.on('moveend',()=>{
    const b=map.getBounds()
    setItems(allFeatures.filter(f=>b.contains(f.geometry.coordinates)))
  })

Fit to data: map.fitBounds(turf.bbox(geojsonData),{padding:60,maxZoom:15})
Measure:     turf.length(turf.lineString(coords)) on each click
`,

layer_control: `
LAYER VISIBILITY AND FILTERING:
Examples: /example/toggle-layers/ /example/filter-markers/ /example/style-switch/

Toggle visibility:
  const vis=map.getLayoutProperty(id,'visibility')
  map.setLayoutProperty(id,'visibility',vis==='visible'?'none':'visible')

Filter by category (one layer per category):
  map.addLayer({id:'places-restaurant',type:'symbol',source:'places',
    filter:['==','category','restaurant'],layout:{'icon-image':'restaurant'}})
  map.setLayoutProperty('places-restaurant','visibility',checked?'visible':'none')

Dynamic filter on single layer:
  map.setFilter('places',['in','category',...activeCategories])

Update paint at runtime:
  map.setPaintProperty('buildings','fill-color',newColor)
  map.setPaintProperty('route','line-width',6)

Update layout at runtime:
  map.setLayoutProperty('labels','text-size',14)

Style switch — re-add custom layers after:
  map.on('style.load',()=>addCustomLayers())
  map.setStyle('mapbox://styles/mapbox/dark-v11')
  // NEVER use setStyle() for incremental changes — only full style swap
  // For incremental: setConfigProperty() / setPaintProperty() / setLayoutProperty()
`,

clustering: `
CLUSTERING:
Examples: /example/cluster/ /example/cluster-html/

Source:
  map.addSource('pts',{type:'geojson',data:fc,
    cluster:true,clusterMaxZoom:14,clusterRadius:50,
    clusterProperties:{sum:['+',['get','magnitude']]}  // optional aggregation
  })

Three layers — ALL required:
  map.addLayer({id:'clusters',type:'circle',source:'pts',
    filter:['has','point_count'],
    paint:{'circle-color':['step',['get','point_count'],'#51bbd6',100,'#f1f075',750,'#f28cb1'],
           'circle-radius':['step',['get','point_count'],20,100,30,750,40]}})

  map.addLayer({id:'cluster-count',type:'symbol',source:'pts',
    filter:['has','point_count'],
    layout:{'text-field':['get','point_count_abbreviated'],
            'text-font':['DIN Offc Pro Medium','Arial Unicode MS Bold'],'text-size':12}})

  map.addLayer({id:'unclustered',type:'circle',source:'pts',
    filter:['!',['has','point_count']],
    paint:{'circle-color':brandColor,'circle-radius':4,'circle-stroke-width':1,'circle-stroke-color':'#fff'}})

Click to expand:
  map.addInteraction('expand',{type:'click',target:{layerId:'clusters'},
    handler:(e)=>{
      const f=map.queryRenderedFeatures(e.point,{layers:['clusters']})[0]
      map.getSource('pts').getClusterExpansionZoom(f.properties.cluster_id,
        (err,zoom)=>{if(!err)map.easeTo({center:f.geometry.coordinates,zoom})})
    }})

HTML custom clusters: use clusterProperties + manually create/destroy Marker instances on 'data' event
`,

animation: `
ANIMATION:
Examples: /example/animate-a-line/ /example/animate-point-along-route/ /example/add-image-animated/ /example/free-camera-path/

Animate growing line:
  const geojson={type:'Feature',geometry:{type:'LineString',coordinates:[]}}
  map.addSource('line',{type:'geojson',data:geojson})
  map.addLayer({id:'line',type:'line',source:'line',slot:'top',paint:{'line-width':3,'line-color':'#ff0'}})
  function frame(){geojson.geometry.coordinates.push(nextPoint);map.getSource('line').setData(geojson);requestAnimationFrame(frame)}

Animate point along path:
  let counter=0
  function animate(){
    point.features[0].geometry.coordinates=arc[counter]
    map.getSource('dot').setData(point)
    if(counter<arc.length) requestAnimationFrame(animate); counter++
  }

Pulsing dot (StyleImageInterface):
  const pulsingDot = { width:100,height:100,data:new Uint8Array(100*100*4),
    onAdd(){this.canvas=document.createElement('canvas');this.ctx=this.canvas.getContext('2d')},
    render(){
      const t=(performance.now()/1000)%1, r=this.width/2
      this.ctx.clearRect(0,0,this.width,this.height)
      this.ctx.arc(r,r,r*(0.4+0.6*t),0,Math.PI*2)
      this.ctx.fillStyle='rgba(255,200,200,'+(1-t)+')'
      this.ctx.fill()
      this.data=this.ctx.getImageData(0,0,this.width,this.height).data
      map.triggerRepaint(); return true
    }
  }
  map.addImage('pulsing',pulsingDot,{pixelRatio:2})

Ant-path dashed line:
  const seq=[[0,4,3],[0.5,4,2.5],[1,4,2],[1.5,4,1.5],[2,4,1],[2.5,4,0.5],[3,4,0],[0,0.5,3.5]]
  function frame(ts){map.setPaintProperty('dashed','line-dasharray',seq[parseInt(ts/50%seq.length)]);requestAnimationFrame(frame)}

Camera rotation: let b=0; function rot(){map.rotateTo((b+=0.1)%360,{duration:0});requestAnimationFrame(rot)}

Scroll story: IntersectionObserver on chapter divs → map.flyTo(chapter.location)

Free camera: map.setFreeCameraOptions(new mapboxgl.FreeCameraOptions(mercatorPos,orientationQuat))
  Use turf.along(line, distance) in rAF loop to interpolate path
`,

threed: `
3D FEATURES:
Examples: /example/add-terrain/ /example/3d-buildings/ /example/add-3d-model/ /example/3d-extrusion-floorplan/

Terrain:
  map.addSource('dem',{type:'raster-dem',url:'mapbox://mapbox.mapbox-terrain-dem-v1',tileSize:512,maxzoom:14})
  map.setTerrain({source:'dem',exaggeration:1.5})

Fog/atmosphere:
  map.setFog({range:[-1,2],'horizon-blend':0.3,color:'#242B4B','high-color':'#161B36','space-color':'#0B1026','star-intensity':0.8})
  map.setFog({})  // simple default

Weather (Standard v3):
  map.setRain({density:0.5,opacity:0.7,intensity:0.8})
  map.setSnow({density:0.4,opacity:1.0,intensity:0.5,vignette:0.3})

3D buildings (classic styles — Standard already includes them):
  const labelId=map.getStyle().layers.find(l=>l.type==='symbol'&&l.layout['text-field']).id
  map.addLayer({id:'3d-buildings',source:'composite','source-layer':'building',
    filter:['==','extrude','true'],type:'fill-extrusion',minzoom:15,
    paint:{
      'fill-extrusion-color':'#aaa',
      'fill-extrusion-height':['interpolate',['linear'],['zoom'],15,0,15.05,['get','height']],
      'fill-extrusion-base':['interpolate',['linear'],['zoom'],15,0,15.05,['get','min_height']],
      'fill-extrusion-opacity':0.6
    }},labelId)

Custom extrusion from GeoJSON:
  map.addLayer({type:'fill-extrusion',source:'rooms',
    paint:{'fill-extrusion-color':['get','color'],'fill-extrusion-height':['get','height'],
           'fill-extrusion-base':['get','base_height'],'fill-extrusion-opacity':0.9}})

Native model layer (v3):
  map.addSource('models',{type:'geojson',data:modelGeoJSON})
  map.addLayer({id:'models',type:'model',source:'models',
    layout:{'model-id':['match',['get','type'],'turbine','turbine-model','default-model']}})

Three.js custom layer:
  {id:'3d',type:'custom',renderingMode:'3d',
   onAdd(map,gl){
     this.renderer=new THREE.WebGLRenderer({canvas:map.getCanvas(),context:gl,antialias:true})
     this.renderer.autoClear=false; this.scene=new THREE.Scene(); this.camera=new THREE.Camera()
   },
   render(gl,matrix){
     this.camera.projectionMatrix=new THREE.Matrix4().fromArray(matrix)
     this.renderer.resetState(); this.renderer.render(this.scene,this.camera)
     map.triggerRepaint()
   }}

Clip layer (remove basemap features in polygon):
  map.addLayer({id:'clip',type:'clip',source:'polygon',
    layout:{'clip-layer-types':['model','symbol'],'clip-layer-scope':['basemap']}})

Query terrain elevation: map.queryTerrainElevation({lng,lat})  // returns meters
`,

data_layers: `
DATA LAYERS — sources and layer types:

GeoJSON (< 500 features / < 500KB):
  map.addSource('data',{type:'geojson',data:fcOrUrl,generateId:true,lineMetrics:true})

Vector tileset:
  map.addSource('ts',{type:'vector',url:'mapbox://username.tileset-id'})
  // Layers MUST specify 'source-layer' for vector sources

Raster:     map.addSource('r',{type:'raster',tiles:['https://host/{z}/{x}/{y}.png'],tileSize:256})
Raster-DEM: map.addSource('dem',{type:'raster-dem',url:'mapbox://mapbox.mapbox-terrain-dem-v1'})
Image overlay:
  map.addSource('img',{type:'image',url:'radar.png',
    coordinates:[[top_left],[top_right],[bottom_right],[bottom_left]]})
  map.addLayer({id:'img',type:'raster',source:'img',paint:{'raster-opacity':0.85}})
WMS:
  map.addSource('wms',{type:'raster',
    tiles:['https://host/wms?SERVICE=WMS&VERSION=1.1.1&BBOX={bbox-epsg-3857}&...'],tileSize:256})

Layer types:
  fill         — polygons (zones, parcels, countries)
  line         — roads, routes, borders, GPS traces
  circle       — point data < 1k; use symbol for icons
  symbol       — icons + labels; prefer over circle for labeled features
  fill-extrusion — 3D polygons (buildings, extruded data)
  heatmap      — density > 5k points; pair with circle at high zoom
  raster       — image tiles, satellite, weather overlays
  model        — 3D models (v3 native)
  clip         — remove basemap features within a polygon (v3)

One source, multiple layers (reuse data, no extra download):
  map.addSource('d',{type:'geojson',data:fc})
  map.addLayer({id:'fill',type:'fill',source:'d',paint:{'fill-color':['get','color'],'fill-opacity':0.4}})
  map.addLayer({id:'line',type:'line',source:'d',paint:{'line-color':'#fff','line-width':1}})
  map.addLayer({id:'label',type:'symbol',source:'d',layout:{'text-field':['get','name']}})

Live update: setInterval(()=>map.getSource('live').setData(updatedFC),1000)

Heatmap (pair with circle at high zoom):
  map.addLayer({id:'heat',type:'heatmap',source:'pts',maxzoom:9,slot:'top',paint:{
    'heatmap-weight':['interpolate',['linear'],['get','mag'],0,0,6,1],
    'heatmap-intensity':['interpolate',['linear'],['zoom'],0,1,9,3],
    'heatmap-color':['interpolate',['linear'],['heatmap-density'],
      0,'rgba(33,102,172,0)',0.2,'rgb(103,169,207)',0.6,'rgb(253,219,199)',1,'rgb(178,24,43)'],
    'heatmap-radius':['interpolate',['linear'],['zoom'],0,2,9,20],
    'heatmap-opacity':['interpolate',['linear'],['zoom'],7,1,9,0]
  }})
`,

react_integration: `
REACT + MAPBOX GL JS:

Install:
  npm install mapbox-gl @mapbox/search-js-react
  npm install @turf/turf  // spatial ops: bbox, along, length, distance

import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'  // REQUIRED — controls invisible without this
mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN  // NEVER hardcode

Standard MapView component:
  export function MapView({ styleUrl, center, zoom, onLoad }) {
    const ref = useRef(null); const map = useRef(null)
    useEffect(() => {
      if (map.current) return  // prevent double-init in StrictMode
      map.current = new mapboxgl.Map({
        container: ref.current,
        style: styleUrl ?? 'mapbox://styles/mapbox/standard',
        center: center ?? [0,0], zoom: zoom ?? 2,
      })
      map.current.on('load', () => onLoad?.(map.current))
      return () => map.current?.remove()  // ALWAYS cleanup on unmount
    }, [])
    return <div ref={ref} style={{width:'100%',height:'100%'}} />
  }

Container MUST have explicit height (zero-height div = invisible map):
  <div style={{width:'100vw',height:'100vh'}}><MapView /></div>

Kick off data fetch BEFORE map load (avoids waterfall):
  const p = fetch('/api/data')                      // starts immediately
  map.on('load', async()=>{addSource(await p)})     // already resolving

Throttle all event listeners:
  import {throttle} from 'lodash'
  map.on('move', throttle(()=>updateSidebar(),100))

Incremental style updates — NEVER call setStyle():
  map.setConfigProperty('basemap','lightPreset','night')  // Standard
  map.setPaintProperty('layer','fill-color','#ff0')       // any style
`,

performance: `
PERFORMANCE:

Marker/layer decision tree:
  ≤100:    HTML Marker (mapboxgl.Marker)
  100–1k:  Symbol/Circle layer (GL-rendered, not DOM)
  1k–100k: Clustered Symbol/Circle (cluster:true)
  >100k:   Vector tileset — GeoJSON freezes the browser

Avoid initialization waterfall (most common bug):
  WRONG: map.on('load',async()=>{const d=await fetch(url);addLayer(d)})
  RIGHT: const p=fetch(url); map.on('load',async()=>{addLayer(await p)})

Layer count: ≤15 custom layers (each = one GPU draw call per frame)
GeoJSON size: ≤500 features / ≤500KB — above either limit use Mapbox Tiling Service
Large polygons (countries, watersheds): always tileset, never inline GeoJSON
Throttle ALL listeners: map.on('move',throttle(fn,100))
Cleanup ALWAYS on unmount: return ()=>{map.remove()}
Source reuse: one source → multiple layers (fill+line+symbol share same source)
`,

token_security: `
TOKEN SECURITY:

Public token (pk.*) — safe in frontend:
  mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN
  Restrict to your domain + *.figma.com; scopes: styles:read fonts:read tiles:read

Secret token (sk.*) — NEVER in frontend:
  Only for server-side Styles API write / MTS upload
  Store in backend .env only, never committed to git

Never commit tokens: .env.local + .gitignore

In Figma Make — ALWAYS do this before generating any map code:
  Required scopes: ['styles:tiles','styles:read','fonts:read','datasets:read']
  1. Call list_tokens_tool() — find a token where note === 'figma-make'
  2. If found: verify it has ALL required scopes
       If scopes match → use its token value as mapboxgl.accessToken
       If scopes are missing → create a new one (step 3); leave the old token as-is
  3. If not found (or scopes insufficient): call create_token_tool({note:'figma-make',scopes:[required]}) and use the returned pk.* value
  4. NEVER rely on an environment default — the figmamake built-in token is expired
  5. Never commit token values to prompts, files, or code
`,

expressions: `
MAPBOX STYLE EXPRESSIONS:

Data access:
  ['get','prop']  ['has','prop']  ['feature-state','selected']
  ['zoom']  ['heatmap-density']  ['line-progress']

Match (discrete values):
  ['match',['get','type'],'restaurant','#f00','hotel','#0ff','#888']  // fallback last

Case (boolean conditions):
  ['case',['boolean',['feature-state','selected'],false],'#f00',['has','vip'],'#gold','#888']

Interpolate (smooth ramp):
  ['interpolate',['linear'],['zoom'],8,'#eee',14,'#555']
  ['interpolate',['linear'],['get','pop'],0,4,1000000,40]

Step (discrete thresholds):
  ['step',['get','point_count'],20,100,30,750,40]  // <100→20, <750→30, else 40

Zoom-driven opacity (fade out):
  ['interpolate',['linear'],['zoom'],7,1,9,0]  // fully visible at z7, gone by z9

Geographic: ['within',polygonGeoJSON]  // true if feature is inside the polygon

String ops: ['concat',['get','name'],' (',['get','type'],')']  ['upcase',['get','name']]

Cluster aggregate (declare on source, use in layer):
  clusterProperties: { sum: ['+',['get','magnitude']] }
  // Access in layer paint: ['get','sum']
`,

}

export const EXAMPLE_URLS: Record<string, string[]> = {
  scaffolding:            ['https://docs.mapbox.com/mapbox-gl-js/example/simple-map/', 'https://docs.mapbox.com/mapbox-gl-js/example/geojson-layer-in-slot/'],
  pins_and_markers:       ['https://docs.mapbox.com/mapbox-gl-js/example/add-a-marker/', 'https://docs.mapbox.com/mapbox-gl-js/example/custom-marker-icons/', 'https://docs.mapbox.com/mapbox-gl-js/example/geojson-markers/', 'https://docs.mapbox.com/mapbox-gl-js/example/drag-a-marker/'],
  popups:                 ['https://docs.mapbox.com/mapbox-gl-js/example/popup/', 'https://docs.mapbox.com/mapbox-gl-js/example/popup-on-click/', 'https://docs.mapbox.com/mapbox-gl-js/example/popup-on-hover/'],
  routing_and_directions: ['https://docs.mapbox.com/mapbox-gl-js/example/mapbox-gl-directions/', 'https://docs.mapbox.com/mapbox-gl-js/example/animate-point-along-route/'],
  search_and_geocoding:   ['https://docs.mapbox.com/mapbox-gl-js/example/mapbox-gl-geocoder-outside-the-map/', 'https://docs.mapbox.com/mapbox-gl-js/example/point-from-geocoder-result/'],
  map_interaction:        ['https://docs.mapbox.com/mapbox-gl-js/example/simple-interactions/', 'https://docs.mapbox.com/mapbox-gl-js/example/queryrenderedfeatures/', 'https://docs.mapbox.com/mapbox-gl-js/example/drag-a-point/'],
  layer_control:          ['https://docs.mapbox.com/mapbox-gl-js/example/toggle-layers/', 'https://docs.mapbox.com/mapbox-gl-js/example/filter-markers/', 'https://docs.mapbox.com/mapbox-gl-js/example/style-switch/'],
  clustering:             ['https://docs.mapbox.com/mapbox-gl-js/example/cluster/', 'https://docs.mapbox.com/mapbox-gl-js/example/cluster-html/'],
  animation:              ['https://docs.mapbox.com/mapbox-gl-js/example/animate-a-line/', 'https://docs.mapbox.com/mapbox-gl-js/example/animate-point-along-route/', 'https://docs.mapbox.com/mapbox-gl-js/example/add-image-animated/', 'https://docs.mapbox.com/mapbox-gl-js/example/free-camera-path/'],
  threed:                 ['https://docs.mapbox.com/mapbox-gl-js/example/add-terrain/', 'https://docs.mapbox.com/mapbox-gl-js/example/3d-buildings/', 'https://docs.mapbox.com/mapbox-gl-js/example/add-3d-model/', 'https://docs.mapbox.com/mapbox-gl-js/example/3d-extrusion-floorplan/'],
  data_layers:            ['https://docs.mapbox.com/mapbox-gl-js/example/geojson-line/', 'https://docs.mapbox.com/mapbox-gl-js/example/heatmap-layer/', 'https://docs.mapbox.com/mapbox-gl-js/example/image-on-a-map/', 'https://docs.mapbox.com/mapbox-gl-js/example/wms/'],
  react_integration:      ['https://docs.mapbox.com/mapbox-gl-js/example/simple-map/'],
  performance:            ['https://docs.mapbox.com/mapbox-gl-js/example/cluster/'],
  token_security:         ['https://docs.mapbox.com/api/accounts/tokens/'],
  expressions:            ['https://docs.mapbox.com/mapbox-gl-js/example/data-driven-circles/', 'https://docs.mapbox.com/mapbox-gl-js/example/within-expressions/'],
}

export const RELATED_PATTERNS: Record<string, string[]> = {
  scaffolding:            ['react_integration', 'token_security', 'data_layers'],
  pins_and_markers:       ['popups', 'clustering', 'map_interaction'],
  popups:                 ['pins_and_markers', 'map_interaction'],
  routing_and_directions: ['search_and_geocoding', 'animation', 'map_interaction'],
  search_and_geocoding:   ['routing_and_directions', 'pins_and_markers'],
  map_interaction:        ['layer_control', 'react_integration', 'performance'],
  layer_control:          ['data_layers', 'map_interaction', 'expressions'],
  clustering:             ['pins_and_markers', 'data_layers', 'performance'],
  animation:              ['threed', 'routing_and_directions', 'data_layers'],
  threed:                 ['animation', 'data_layers', 'performance'],
  data_layers:            ['clustering', 'layer_control', 'performance', 'expressions'],
  react_integration:      ['scaffolding', 'performance', 'token_security'],
  performance:            ['clustering', 'data_layers', 'react_integration'],
  token_security:         ['react_integration', 'scaffolding'],
  expressions:            ['data_layers', 'layer_control', 'clustering'],
}

// [keyword list, segment note string]
export const SEGMENT_NOTES: Array<[string[], string]> = [
  [['delivery', 'driver', 'courier', 'logistics', 'fleet'],
   'SEGMENT NOTE (logistics): Customer view=ambient/faded basemap/brand color on courier dot only. Driver view=max address legibility/buildings at z16+/no decorative POIs. Ops dashboard=circle layers not HTML markers/cluster all fleet dots/geofence fills ≤40% opacity.'],
  [['real estate', 'listing', 'property', 'parcel', 'housing'],
   'SEGMENT NOTE (real estate): Pin primacy. POI labels off at z15+ (showPointOfInterestLabels:false). No 3D buildings (obscure parcels). Cluster above z10. Faded/muted basemap — desaturate everything not a listing.'],
  [['store locator', 'retail', 'shop'],
   'SEGMENT NOTE (store locator): GeoJSON source with cluster:true. Sidebar list synced to viewport via moveend. Distance via turf.distance(). "Get directions" CTA uses Directions API. fitBounds to all results on load.'],
  [['travel', 'discover', 'tourism', 'hospitality'],
   'SEGMENT NOTE (travel): showPointOfInterestLabels:true, showLandmarkIcons:true, show3dBuildings:true. Pedestrian viewpoint — demote highways, promote parks/landmarks. Default zoom z14 not z9.'],
  [['automotive', 'navigation', 'turn-by-turn', 'in-car', 'headunit'],
   "SEGMENT NOTE (automotive): Route slot:'top' always. line-occlusion-opacity:0.5 for 3D tunnels. Brand color on route only — not on basemap roads. Night: dark theme + high contrast labels."],
  [['outdoor', 'trail', 'hike', 'fitness', 'strava'],
   "SEGMENT NOTE (outdoors): theme:'outdoors'. Terrain dominant. GPS trace max 4px at z14. Never let thick GPS lines cover elevation contours."],
]
