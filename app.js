// ================= 地圖初始化 =================
const map = L.map("map", { tap: true }).setView([25.03, 121.56], 12);
const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap" }).addTo(map);
const otm = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", { maxZoom: 18, maxNativeZoom: 17, attribution: 'OpenTopoMap' });

const mapDiv = document.getElementById('map');
const rsContainer = document.getElementById('routeSelectContainer');
mapDiv.appendChild(rsContainer); // 強行塞回地圖內，但這是在 Leaflet 初始化之後做的

// 防止點擊選單地圖會動
L.DomEvent.disableClickPropagation(rsContainer);

let showWptNameAlways = false; // 預設不直接顯示名字
const emap = L.tileLayer("https://wmts.nlsc.gov.tw/wmts/EMAP/default/GoogleMapsCompatible/{z}/{y}/{x}", {
    maxZoom: 19,
    attribution: "內政部臺灣通用電子地圖",
    opacity: 1.0,
});

// --- 格線圖層全域變數 ---
let gridLayers = {
    "WGS84": L.layerGroup(),
    "TWD97": L.layerGroup(),
    "TWD67": L.layerGroup(),
    "SubGrid": L.layerGroup()
};

// --- 地圖初始化部分的圖層控制 ---
const baseMaps = { 
    "標準地圖 (OSM)": osm, 
    "等高線地形圖 (OpenTopo)": otm,
    "內政部臺灣通用電子地圖": emap
    
};

const overlayMaps = {
    "WGS84 格線": gridLayers.WGS84,
    "TWD97 格線": gridLayers.TWD97,
    "TWD67 格線": gridLayers.TWD67,
    "顯示百米細格": gridLayers.SubGrid  // 新增：獨立的 Checkbox
};

L.control.layers(baseMaps, overlayMaps).addTo(map);

map.on('overlayadd', updateGrids);

let allTracks = [], trackPoints = [], polyline, hoverMarker, chart, markers = [], wptMarkers = [];
let pointA = null, pointB = null, markerA = null, markerB = null;
let currentPopup = null; 
let isMouseDown = false; 
let mapTipTimer = null;
let gpsMarker = null;
let currentFocusId = null;
let isMultiGpxMode = false;
const backgroundTracksLayer = L.layerGroup().addTo(map);
const routeSelect = document.getElementById("routeSelect");

let clickTimeout = null;

map.on('click', (e) => {
    // 優先偵測是否點擊在目前選中的路徑 (trackPoints) 附近
    let closest = null;
    let minD = Infinity;

    if (trackPoints && trackPoints.length > 0) {
        trackPoints.forEach(p => {
            const d = Math.sqrt(Math.pow(p.lat - e.latlng.lat, 2) + Math.pow(p.lon - e.latlng.lng, 2));
            if (d < minD) { minD = d; closest = p; }
        });
    }

    // 距離 100 公尺內則判定為點擊路徑
    if (closest && minD * 111000 < 5) {
        if (clickTimeout) clearTimeout(clickTimeout); 
        L.popup()
            .setLatLng([closest.lat, closest.lng])
            .setContent(`
                <div style="font-size:14px; line-height:1.6;">
                    <b>路徑位置資訊</b><br>
                    海拔: ${closest.ele.toFixed(1)} m<br>
                    里程: ${(closest.dist / 1000).toFixed(2)} km<br>
                    <hr style="margin:8px 0; border:0; border-top:1px solid #ccc;">
                    <div style="display:flex; gap:5px;">
                        <button onclick="setPoint('A', ${closest.lat}, ${closest.lng})" style="flex:1; cursor:pointer; padding:4px;">設為 A 點</button>
                        <button onclick="setPoint('B', ${closest.lat}, ${closest.lng})" style="flex:1; cursor:pointer; padding:4px;">設為 B 點</button>
                    </div>
                </div>
            `)
            .openOn(map);
    } 
    else {
        // 原本的空白處點擊逻辑
        clickTimeout = setTimeout(() => {
            showFreeClickPopup(e.latlng);
        }, 200);
    }
});

function processGpxXml(text) {
    const xml = new DOMParser().parseFromString(text, "application/xml");
    const tempTracks = [];
    
    // 1. 先取得所有原始航點 (wpt)
    const wpts = xml.getElementsByTagName("wpt");
    let allWpts = [];
    for (let w of wpts) {
        const lat = parseFloat(w.getAttribute("lat")), lon = parseFloat(w.getAttribute("lon"));
        const name = w.getElementsByTagName("name")[0]?.textContent || "未命名航點";
        const time = w.getElementsByTagName("time")[0]?.textContent;
        // 沿用原本的 formatDate 與時區處理
        allWpts.push({ 
            lat, lon, name, 
            localTime: time ? formatDate(new Date(new Date(time).getTime() + 8*3600000)) : "無時間資訊" 
        });
    }

    // 2. 處理每一條路線 (trk)
    const trks = xml.getElementsByTagName("trk");
    for (let i = 0; i < trks.length; i++) {
        const pts = trks[i].getElementsByTagName("trkpt");
        const points = extractPoints(pts); // 呼叫原本的 extractPoints
        
        // 沿用原本的 500 公尺航點過濾邏輯
        const routeWaypoints = allWpts.filter(w => {
            return points.some(p => {
                const d = Math.sqrt((w.lat - p.lat)**2 + (w.lon - p.lon)**2) * 111000;
                return d < 500;
            });
        });

        if (points.length > 0) {
            tempTracks.push({ 
                name: trks[i].getElementsByTagName("name")[0]?.textContent || `路線 ${i + 1}`, 
                points, 
                waypoints: routeWaypoints 
            });
        }
    }

    // --- 關鍵修正：處理純航點情況 ---
    // 如果循環結束後沒有軌跡點 (tempTracks 為空)，但有找到全域航點 (allWpts 有東西)
    if (tempTracks.length === 0 && allWpts.length > 0) {
        tempTracks.push({
            name: "航點資料", // 您可以自訂這個名稱
            points: [],       // 給予空陣列避免後續報錯
            waypoints: allWpts // 直接將所有抓到的航點塞入
        });
    }

    return tempTracks;
}


// ================= 格線繪製邏輯 =================
function updateGrids() {
    const zoom = map.getZoom();
    const bounds = map.getBounds();
    
    // 清除所有舊圖層
    gridLayers.WGS84.clearLayers();
    gridLayers.TWD97.clearLayers();
    gridLayers.TWD67.clearLayers();
    gridLayers.SubGrid.clearLayers();

    if (zoom < 10) return; 

    // 設定公里格線間距
    let stepMeter = zoom > 13 ? 1000 : 5000;
    let subStepMeter = 100; // 百米間距

    const createLabel = (lat, lon, text, color, anchor = [0, 0]) => {
        return L.marker([lat, lon], {
            icon: L.divIcon({
                className: 'grid-label',
                html: `<div style="color: ${color}; font-size: 10px; font-weight: bold; text-shadow: 1px 1px 2px #fff; white-space: nowrap; background: rgba(255,255,255,0.5); padding: 1px 3px; border-radius: 2px;">${text}</div>`,
                iconSize: [0, 0],
                iconAnchor: anchor
            }),
            interactive: false
        });
    };

    // 繪製 TWD 邏輯
    const drawTWDGrid = (layer, def, color) => {
        if (!map.hasLayer(layer)) return;
        
        const sw = proj4(WGS84_DEF, def, [bounds.getWest(), bounds.getSouth()]);
        const ne = proj4(WGS84_DEF, def, [bounds.getEast(), bounds.getNorth()]);

        // A. 繪製主公里線 (1km)
        for (let x = Math.floor(sw[0]/stepMeter)*stepMeter; x <= ne[0]; x += stepMeter) {
            let p_top = proj4(def, WGS84_DEF, [x, ne[1]]);
            let p_bot = proj4(def, WGS84_DEF, [x, sw[1]]);
            L.polyline([[p_top[1], p_top[0]], [p_bot[1], p_bot[0]]], {color: color, weight: 1.2, opacity: 0.6, interactive: false}).addTo(layer);
            createLabel(p_top[1], p_top[0], Math.round(x), color, [0, 0]).addTo(layer);
            createLabel(p_bot[1], p_bot[0], Math.round(x), color, [0, 20]).addTo(layer);
        }
        for (let y = Math.floor(sw[1]/stepMeter)*stepMeter; y <= ne[1]; y += stepMeter) {
            let p_left = proj4(def, WGS84_DEF, [sw[0], y]);
            let p_right = proj4(def, WGS84_DEF, [ne[0], y]);
            L.polyline([[p_left[1], p_left[0]], [p_right[1], p_right[0]]], {color: color, weight: 1.2, opacity: 0.6, interactive: false}).addTo(layer);
            createLabel(p_left[1], p_left[0], Math.round(y), color, [-5, 12]).addTo(layer);
            createLabel(p_right[1], p_right[0], Math.round(y), color, [55, 12]).addTo(layer);
        }

        // B. 繪製百米細線 (只有在「顯示百米細格」被勾選且 Zoom 足夠大時)
        if (map.hasLayer(gridLayers.SubGrid) && zoom >= 13) {
            for (let x = Math.floor(sw[0]/subStepMeter)*subStepMeter; x <= ne[0]; x += subStepMeter) {
                if (x % 1000 === 0) continue; 
                let p_top = proj4(def, WGS84_DEF, [x, ne[1]]);
                let p_bot = proj4(def, WGS84_DEF, [x, sw[1]]);
                L.polyline([[p_top[1], p_top[0]], [p_bot[1], p_bot[0]]], {color: color, weight: 0.8, opacity: 0.8, dashArray: '2, 4', interactive: false}).addTo(gridLayers.SubGrid);
            }
            for (let y = Math.floor(sw[1]/subStepMeter)*subStepMeter; y <= ne[1]; y += subStepMeter) {
                if (y % 1000 === 0) continue;
                let p_left = proj4(def, WGS84_DEF, [sw[0], y]);
                let p_right = proj4(def, WGS84_DEF, [ne[0], y]);
                L.polyline([[p_left[1], p_left[0]], [p_right[1], p_right[0]]], {color: color, weight: 0.8, opacity: 0.8, dashArray: '2, 4', interactive: false}).addTo(gridLayers.SubGrid);
            }
        }
    };

    drawTWDGrid(gridLayers.TWD97, TWD97_DEF, '#4a90e2'); 
    drawTWDGrid(gridLayers.TWD67, TWD67_DEF, '#e67e22');

    // WGS84 繪製 (略過標籤重複部分...)
if (map.hasLayer(gridLayers.WGS84)) {
        let stepDeg = zoom > 14 ? 0.005 : (zoom > 12 ? 0.01 : 0.05); // 動態間距
        const wgsColor = '#666'; // 使用深灰色讓文字更清楚

        // 垂直線 (經度 Longitude)
        for (let lo = Math.floor(bounds.getWest()/stepDeg)*stepDeg; lo <= bounds.getEast(); lo += stepDeg) {
            L.polyline([[bounds.getSouth(), lo], [bounds.getNorth(), lo]], {
                color: wgsColor, 
                weight: 1, 
                opacity: 0.5, 
                dashArray: '5,10', 
                interactive: false
            }).addTo(gridLayers.WGS84);
            
            // 標註經度 (上方與下方)
            createLabel(bounds.getNorth(), lo, lo.toFixed(3) + '°E', wgsColor, [0, 0]).addTo(gridLayers.WGS84);
            createLabel(bounds.getSouth(), lo, lo.toFixed(3) + '°E', wgsColor, [0, 20]).addTo(gridLayers.WGS84);
        }

        // 水平線 (緯度 Latitude)
        for (let la = Math.floor(bounds.getSouth()/stepDeg)*stepDeg; la <= bounds.getNorth(); la += stepDeg) {
            L.polyline([[la, bounds.getWest()], [la, bounds.getEast()]], {
                color: wgsColor, 
                weight: 1, 
                opacity: 0.5, 
                dashArray: '5,10', 
                interactive: false
            }).addTo(gridLayers.WGS84);
            
            // 標註緯度 (左側與右側)
            createLabel(la, bounds.getWest(), la.toFixed(3) + '°N', wgsColor, [-5, 12]).addTo(gridLayers.WGS84);
            createLabel(la, bounds.getEast(), la.toFixed(3) + '°N', wgsColor, [55, 12]).addTo(gridLayers.WGS84);
        }
    }
}

map.on('moveend', updateGrids);


// 建立全螢幕控制按鈕
const fullScreenBtn = L.control({ position: 'topleft' });

fullScreenBtn.onAdd = function() {
    const btn = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
    btn.innerHTML = '⛶'; // 全螢幕符號
    btn.style.backgroundColor = 'white';
    btn.style.width = '30px';
    btn.style.height = '30px';
    btn.style.lineHeight = '30px';
    btn.style.textAlign = 'center';
    btn.style.cursor = 'pointer';
    btn.style.fontSize = '22px';
    btn.style.fontWeight = 'bold';
    btn.title = '切換全螢幕模式';

    L.DomEvent.disableClickPropagation(btn);
    
    btn.onclick = function() {
        const mapElement = document.getElementById('map');
  // 檢查瀏覽器是否支援原生全螢幕 API
    const canNativeFull = mapElement.requestFullscreen || mapElement.webkitRequestFullscreen;

    if (canNativeFull) {
        // --- 原本的邏輯：支援全螢幕的裝置 (PC, Android, iPad) ---
        if (!document.fullscreenElement && !document.webkitFullscreenElement) {
            if (mapElement.requestFullscreen) mapElement.requestFullscreen();
            else if (mapElement.webkitRequestFullscreen) mapElement.webkitRequestFullscreen();
        } else {
            if (document.exitFullscreen) document.exitFullscreen();
            else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
        }
    } else {
        // --- 針對 iPhone 的解決方案：偽全螢幕 ---
        if (!mapElement.classList.contains('iphone-fullscreen')) {
            mapElement.classList.add('iphone-fullscreen');
            btn.innerHTML = '✕'; // 變更按鈕圖示，提示關閉
            // 隱藏頁面其他部分，讓地圖看起來是全螢幕
            document.body.style.overflow = 'hidden'; 
        } else {
            mapElement.classList.remove('iphone-fullscreen');
            btn.innerHTML = '⛶';
            document.body.style.overflow = '';
        }
        
        if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        if (mapElement.requestFullscreen) {
            mapElement.requestFullscreen();
        } else if (mapElement.webkitRequestFullscreen) {
            mapElement.webkitRequestFullscreen(); // 針對 iPad Safari
        }
    } else {
        if (document.exitFullscreen) {
            document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
        }
    }
        // 修正地圖尺寸
        setTimeout(() => map.invalidateSize(), 500);
    }
    };
    return btn;
};

fullScreenBtn.addTo(map);

// 專門處理「非路徑點」的彈窗
function showFreeClickPopup(latlng) {
    const twd97 = proj4(WGS84_DEF, TWD97_DEF, [latlng.lng, latlng.lat]);
    const twd67 = proj4(WGS84_DEF, TWD67_DEF, [latlng.lng, latlng.lat]);
    
    const x97 = Math.round(twd97[0]);
    const y97 = Math.round(twd97[1]);
    const x67 = Math.round(twd67[0]);
    const y67 = Math.round(twd67[1]);

    const gUrl = `https://www.google.com/maps?q=${latlng.lat},${latlng.lng}`;
    
    // 定義按鈕化的圖示連結
    const gMapIconBtn = `
        <a href="${gUrl}" target="_blank" title="於 Google Map 開啟" 
           style="text-decoration:none; margin-right:8px; display:inline-flex; align-items:center; justify-content:center; width: 28px; height: 28px; background: #fff; border: 1px solid #ccc; border-radius: 50%; box-shadow: 0 2px 4px rgba(0,0,0,0.2); vertical-align: middle;">
            <img src="https://ychiking.github.io/gpx-online-viewer/GoogleMaps.png" style="width:18px; height:18px; display:block;" alt="GMap">
        </a>`;

    const content = `
        <div style="min-width:180px; font-size:13px; line-height:1.6;">
          <div style="display:flex; align-items:center; margin-bottom:5px;">
            ${gMapIconBtn}
            <b style="font-size:14px; color:#d35400;">自選位置</b>
          </div>
          <hr style="margin:5px 0; border:0; border-top:1px solid #eee;">
          <b>WGS84:</b> ${latlng.lat.toFixed(6)}, ${latlng.lng.toFixed(6)}<br>
          <b>TWD97:</b> ${x97}, ${y97}<br>
          <b>TWD67:</b> ${x67}, ${y67}
          <div style="display:flex; margin-top:10px; gap:8px;">
            <button onclick="setFreeAB('A', ${latlng.lat}, ${latlng.lng})" style="flex:1; background:#007bff; color:white; border:none; padding:6px; border-radius:4px; cursor:pointer; font-weight:bold;">設定 A</button>
            <button onclick="setFreeAB('B', ${latlng.lat}, ${latlng.lng})" style="flex:1; background:#e83e8c; color:white; border:none; padding:6px; border-radius:4px; cursor:pointer; font-weight:bold;">設定 B</button>
          </div>
        </div>`;
    
    L.popup().setLatLng(latlng).setContent(content).openOn(map);
}

window.setFreeAB = function(type, lat, lon) {
    // === 自動關閉定位標記與還原按鈕顏色 ===
    if (gpsMarker) {
        map.removeLayer(gpsMarker);
        gpsMarker = null;
        
        
        if (gpsInterval) { clearInterval(gpsInterval); gpsInterval = null; }
        // 使用剛才存下來的變數直接修改顏色
        if (gpsButtonElement) {
            gpsButtonElement.style.background = "white";
        }
    }

    // --- 以下維持你原始的邏輯 ---
    const p = { lat, lon, ele: 0, distance: 0, timeLocal: "無時間資訊", timeUTC: 0, idx: -1 };
    
    if (type === 'A') {
        pointA = p;
        if (markerA) map.removeLayer(markerA);
        markerA = L.marker([lat, lon], { 
            icon: L.divIcon({ 
                html: `<div style="background:#007bff;color:white;border-radius:50%;width:24px;height:24px;text-align:center;line-height:24px;font-weight:bold;border:2px solid white;box-shadow:0 2px 4px rgba(0,0,0,0.3);">A</div>`, 
                iconSize: [24, 24], 
                iconAnchor: [12, 12],
                className: '' 
            }) 
        }).addTo(map);
    } else {
        pointB = p;
        if (markerB) map.removeLayer(markerB);
        markerB = L.marker([lat, lon], { 
            icon: L.divIcon({ 
                html: `<div style="background:#e83e8c;color:white;border-radius:50%;width:24px;height:24px;text-align:center;line-height:24px;font-weight:bold;border:2px solid white;box-shadow:0 2px 4px rgba(0,0,0,0.3);">B</div>`, 
                iconSize: [24, 24], 
                iconAnchor: [12, 12],
                className: '' 
            }) 
        }).addTo(map);
    }
    
    map.closePopup();
    updateABUI();
};


// ================= 下拉選單切換事件 =================
routeSelect.addEventListener("change", (e) => {
    const selectedIndex = parseInt(e.target.value);
    loadRoute(selectedIndex);
});

// ================= 定義圖示 =================
const startIcon = new L.Icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-green.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
  iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41]
});
const endIcon = new L.Icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-red.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
  iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41]
});
const wptIcon = new L.Icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-blue.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
  iconSize: [20, 32], iconAnchor: [10, 32], popupAnchor: [1, -28], shadowSize: [32, 32]
});

// ================= A/B 點與解析邏輯 =================
window.clearABSettings = function() {
  pointA = null; pointB = null;
  if (markerA) { map.removeLayer(markerA); markerA = null; }
  if (markerB) { map.removeLayer(markerB); markerB = null; }
  updateABUI();
  map.closePopup(); 
};

document.getElementById("gpxInput").addEventListener("change", e => {
    // 1. 徹底清除所有舊狀態
    clearEverything(); 

    const file = e.target.files[0];
    if (!file) return;
    
    // 取得不含副檔名的檔名
    const gpxFileName = file.name.replace(/\.[^/.]+$/, "");
    
    document.getElementById("fileNameDisplay").textContent = file.name;
    map.closePopup(); 
    
    const toggleBtn = document.getElementById("toggleChartBtn");
    if (toggleBtn) {
        toggleBtn.style.display = "block"; // 匯入後才顯示
        toggleBtn.textContent = "收合高度表"; 
    }

    // --- 修改處 1: 確保單檔匯入時隱藏多檔按鈕列 ---
    const multiBar = document.getElementById('multiGpxBtnBar');
    if (multiBar) multiBar.style.display = 'none';

    const reader = new FileReader();
    reader.onload = () => {
        // --- 修改處 2: 傳入 gpxFileName ---
        // 這樣 parseGPX 內部的「結合路線」就會正確顯示為你的檔名
        parseGPX(reader.result, gpxFileName);
    };
    reader.readAsText(file);

    // 清空 input 的 value
    e.target.value = ""; 
});

// 建議新增一個統一的重置函式，確保所有模式切換都乾淨
function clearEverything() {
    // 執行原本的重設 (清除 A/B點、藍色分析線、trackPoints 等)
    if (typeof window.resetGPS === 'function') window.resetGPS();
    
    // 清除單個模式的舊線條
    if (typeof polyline !== 'undefined' && polyline) {
        map.removeLayer(polyline);
    }

    // 清除多檔案模式的殘留
    if (typeof multiGpxStack !== 'undefined') {
        multiGpxStack.forEach(item => {
            if (item.layer) map.removeLayer(item.layer);
        });
        multiGpxStack = [];
    }

    // 清除並隱藏多檔按鈕列
    const multiBar = document.getElementById('multiGpxBtnBar');
    if (multiBar) {
        multiBar.innerHTML = '';
        multiBar.style.display = 'none';
    }

    // 銷毀舊高度圖表
    if (window.chart) {
        window.chart.destroy();
        window.chart = null;
    }

    // 清空文字資訊
    const summary = document.getElementById("routeSummary");
    if (summary) summary.innerHTML = "";
    const wptList = document.getElementById("wptList");
    if (wptList) wptList.innerHTML = "";
}

function parseGPX(text, fileName, shouldFit = true) { 
  const xml = new DOMParser().parseFromString(text, "application/xml");
  allTracks = [];
  const routeSelect = document.getElementById("routeSelect"); 
  routeSelect.innerHTML = "";
  
  // 先處理檔名：移除副檔名 (例如：abc.gpx -> abc)
  const displayName = fileName ? fileName.replace(/\.[^/.]+$/, "") : "結合路線";

  // 1. 取得所有原始航點 (wpt)
  const wpts = xml.getElementsByTagName("wpt");
  let allWpts = [];
  for (let w of wpts) {
    const lat = parseFloat(w.getAttribute("lat")), lon = parseFloat(w.getAttribute("lon"));
    const name = w.getElementsByTagName("name")[0]?.textContent || "未命名航點";
    const time = w.getElementsByTagName("time")[0]?.textContent;
    const ele = w.getElementsByTagName("ele")[0]?.textContent; // 建議順便取得高度
    allWpts.push({ 
      lat, lon, name, 
      ele: ele ? parseFloat(ele) : 0,
      localTime: time ? formatDate(new Date(new Date(time).getTime() + 8*3600000)) : "無時間資訊" 
    });
  }

  // 2. 處理每一條路線 (trk)
  const trks = xml.getElementsByTagName("trk");
  let combinedPoints = [];
  let combinedWaypoints = [];

  for (let i = 0; i < trks.length; i++) {
    const pts = trks[i].getElementsByTagName("trkpt");
    const points = extractPoints(pts);
    
    if (points.length > 0) {
      const trackData = { 
        name: trks[i].getElementsByTagName("name")[0]?.textContent || `路線 ${i + 1}`, 
        points, 
        waypoints: [] 
      };

      trackData.waypoints = allWpts.filter(w => {
        return points.some(p => {
          const d = Math.sqrt((w.lat - p.lat)**2 + (w.lon - p.lon)**2) * 111000;
          return d < 500;
        });
      });

      allTracks.push(trackData);
      combinedPoints = combinedPoints.concat(points);
      trackData.waypoints.forEach(rw => {
          if (!combinedWaypoints.find(cw => cw.name === rw.name && cw.lat === rw.lat)) {
              combinedWaypoints.push(rw);
          }
      });
    }
  }

  // --- 新增處理：如果沒有軌跡但有航點，建立虛擬軌跡讓程式能繼續運行 ---
  if (allTracks.length === 0 && allWpts.length > 0) {
    allTracks.push({
      name: displayName || "僅含航點資料",
      points: [], // 雖然沒有軌跡點，但讓結構完整
      waypoints: allWpts
    });
  }

  // --- 修改：增加結合選項 (僅在真的有多條軌跡時執行) ---
  if (allTracks.length > 1) {
    let totalDist = 0;
    const reCalibratedPoints = combinedPoints.map((p, idx, arr) => {
        if (idx > 0) {
            const a = arr[idx-1], R = 6371;
            const dLat = (p.lat - a.lat) * Math.PI / 180, dLon = (p.lon - a.lon) * Math.PI / 180;
            const x = Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180) * Math.cos(p.lat*Math.PI/180) * Math.sin(dLon/2)**2;
            totalDist += 2 * R * Math.asin(Math.sqrt(x));
        }
        return { ...p, distance: totalDist };
    });

    allTracks.unshift({
      name: displayName, // 此處已改為顯示移除副檔名後的檔名
      points: reCalibratedPoints,
      waypoints: combinedWaypoints,
      isCombined: true
    });
  }

  // 3. 渲染下拉選單
  const container = document.getElementById("routeSelectContainer");
  if (allTracks.length > 1) {
    // 先清空，再加資料
    routeSelect.innerHTML = "";
    allTracks.forEach((t, i) => {
        const opt = document.createElement("option"); 
        opt.value = i; 
        opt.textContent = t.name;
        routeSelect.appendChild(opt); // 繼續用你的 routeSelect，沒問題！
    });

    // 設定外層位置
    container.style.cssText = "display: block !important; position: absolute; top: 10px; left: 60px; z-index: 9999;";

    // 直接改 routeSelect 的顏色 (深灰邊框)
    routeSelect.style.cssText = `
        height: 30px;
        padding: 0 8px;
        border-radius: 15px;
        border: 2px solid #555555;   /* 深灰色邊框 */
        background: rgba(255, 255, 255, 0.9);
        color: #333333;
        font-size: 13px;
        cursor: pointer;
        outline: none;
    `;
} else {
    container.style.display = "none";
}
  
  // 如果有資料才載入，避免 allTracks[0] 為 undefined 報錯
  if (allTracks.length > 0) {
    loadRoute(0, shouldFit);
  } else {
    alert("此 GPX 檔案不含有效的軌跡或航點資料。");
  }
}
function extractPoints(pts) {
  let res = [], total = 0;
  for (let i = 0; i < pts.length; i++) {
    const lat = parseFloat(pts[i].getAttribute("lat")), 
          lon = parseFloat(pts[i].getAttribute("lon"));
    const eleNode = pts[i].getElementsByTagName("ele")[0];
    const timeNode = pts[i].getElementsByTagName("time")[0];

    if (!isNaN(lat) && !isNaN(lon)) {
      const ele = eleNode ? parseFloat(eleNode.textContent) : 0;
      
      // ✅ 修正點：必須檢查內容是否為空字串
      let utc = null;
      let localTime = "無時間資訊";
      
      if (timeNode && timeNode.textContent.trim() !== "") {
        const d = new Date(timeNode.textContent);
        if (!isNaN(d.getTime())) {
          utc = d;
          localTime = formatDate(new Date(utc.getTime() + 8*3600*1000));
        }
      }

      if (res.length > 0) {
        const a = res[res.length-1], R = 6371;
        const dLat = (lat-a.lat)*Math.PI/180, dLon = (lon-a.lon)*Math.PI/180;
        const x = Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(lat*Math.PI/180)*Math.sin(dLon/2)**2;
        
        // 使用 Math.max(0, x) 確保不會因為微小誤差導致負數產生 NaN
        total += 2 * R * Math.asin(Math.sqrt(Math.max(0, x)));
      }
      
      res.push({ 
        lat, 
        lon, 
        ele, 
        timeUTC: utc ? utc.getTime() : null, // 存入數值或 null，不要存 Invalid Date
        timeLocal: localTime, 
        distance: total 
      });
    }
  }
  return res;
}

function calculateElevationGainFiltered(points = trackPoints) {
  if (points.length < 3) return { gain: 0, loss: 0 };
  let cleanPoints = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prevEle = points[i-1].ele, currEle = points[i].ele;
    cleanPoints.push(Math.abs(currEle - prevEle) > 100 ? { ...points[i], ele: prevEle } : points[i]);
  }
  const smoothed = cleanPoints.map((p, i, arr) => {
    const start = Math.max(0, i - 1), end = Math.min(arr.length - 1, i + 1);
    return arr.slice(start, end + 1).reduce((s, c) => s + c.ele, 0) / (end - start + 1);
  });
  let gain = 0, loss = 0, threshold = 4, lastEle = smoothed[0];
  for (let i = 1; i < smoothed.length; i++) {
    const diff = smoothed[i] - lastEle;
    if (Math.abs(diff) >= threshold) { if (diff > 0) gain += diff; else loss += Math.abs(diff); lastEle = smoothed[i]; }
  }
  return { gain, loss };
}

function getBearingInfo(lat1, lon1, lat2, lon2) {
    const toRad = deg => deg * Math.PI / 180;
    const toDeg = rad => rad * 180 / Math.PI;
    const dLon = toRad(lon2 - lon1);
    const y = Math.sin(dLon) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
    let bearing = (toDeg(Math.atan2(y, x)) + 360) % 360;
    const directions = ["北", "東北", "東", "東南", "南", "西南", "西", "西北"];
    const index = Math.round(bearing / 45) % 8;
    return { deg: bearing.toFixed(0), name: directions[index] };
}

// 在 setupProgressBar 函式中加入這段監聽器
function setupProgressBar() {
    const barContainer = document.getElementById("map-control-bar");
    const progressBar = document.getElementById("gpxProgressBar");
    if (!barContainer || !progressBar) return;

    // 阻止滑動條的操作影響到地圖拖動 (手機上非常重要)
    L.DomEvent.disableClickPropagation(barContainer);
    L.DomEvent.disableScrollPropagation(barContainer);

    // 統一檢查顯示狀態的邏輯
    const updateVisibility = () => {
        // 偵測是否處於全螢幕狀態 (電腦端 API || iPhone 專用的 Class)
        const isStandardFull = !!(document.fullscreenElement || document.webkitFullscreenElement);
        const isIphoneFull = document.body.classList.contains('iphone-fullscreen');
        
        // 只有在全螢幕「且」有資料時才顯示
        if ((isStandardFull || isIphoneFull) && typeof trackPoints !== 'undefined' && trackPoints.length > 0) {
            barContainer.style.setProperty('display', 'flex', 'important');
        } else {
            barContainer.style.setProperty('display', 'none');
        }
    };

    // 監聽電腦/安卓標準全螢幕事件
    document.addEventListener('fullscreenchange', updateVisibility);
    document.addEventListener('webkitfullscreenchange', updateVisibility);

    // 核心：監聽 iPhone 模式切換 (偵測 body 的 class 變化)
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if (mutation.attributeName === 'class') {
                updateVisibility();
            }
        });
    });
    observer.observe(document.body, { attributes: true });

    // 進度條拉動邏輯
    progressBar.addEventListener("input", function() {
        const idx = parseInt(this.value);
        if (!trackPoints || !trackPoints[idx]) return;
        const p = trackPoints[idx];

        if (hoverMarker) {
            hoverMarker.setLatLng([p.lat, p.lon]).bringToFront();
            if (!map.getBounds().contains([p.lat, p.lon])) {
                map.panTo([p.lat, p.lon], { animate: false }); // 手機關閉動畫較流暢
            }
        }
        document.getElementById("progressBarInfo").textContent = `${p.distance.toFixed(2)} km`;
        
        if (typeof showCustomPopup === 'function') {
            const checkbox = document.getElementById("showChartTipCheckbox");
            if (!checkbox || checkbox.checked) {
                showCustomPopup(idx, "位置資訊");
            }
        }
    });
}

function initProgressBar() {
    const bar = document.getElementById("gpxProgressBar");
    if (typeof trackPoints !== 'undefined' && trackPoints.length > 0 && bar) {
        bar.max = trackPoints.length - 1;
        bar.value = 0;
        document.getElementById("progressBarInfo").textContent = "0.00 km";
        // 不要設定 barContainer.style.display，讓 updateVisibility 去判斷
    }
}
// ================= 地圖載入與連動 =================
function loadRoute(index, customColor = null) {
    window.currentActiveIndex = index;

    map.closePopup();
    if (typeof window.clearABSettings === 'function') window.clearABSettings();

    const sel = allTracks[index];
    if (!sel) return;
    
    const wptToggleContainer = document.getElementById("wptToggleContainer");
    if (wptToggleContainer) wptToggleContainer.style.display = "block";

    if (hoverMarker) {
        map.removeLayer(hoverMarker);
        hoverMarker = null;
    }

    trackPoints = sel.points || []; 
    
    /**
     * ✅ 強化版斷線函數
     * 作用：將一維座標陣列拆解為二維，消除跳躍直線
     */
    const breakTracks = (pts) => {
        if (!pts || pts.length === 0) return [];
        const result = [];
        let currentSeg = [pts[0]];
        
        for (let j = 1; j < pts.length; j++) {
            const p1 = pts[j-1];
            const p2 = pts[j];

            // 取得精確座標 (相容多種 Leaflet 與 GPX 解析格式)
            const lat1 = p1.lat !== undefined ? p1.lat : (p1[0] !== undefined ? p1[0] : p1.lat);
            const lng1 = p1.lng !== undefined ? p1.lng : (p1.lon !== undefined ? p1.lon : (p1[1] !== undefined ? p1[1] : p1.lng));
            const lat2 = p2.lat !== undefined ? p2.lat : (p2[0] !== undefined ? p2[0] : p2.lat);
            const lng2 = p2.lng !== undefined ? p2.lng : (p2.lon !== undefined ? p2.lon : (p2[1] !== undefined ? p2[1] : p2.lng));

            const d = Math.sqrt(Math.pow(lat1 - lat2, 2) + Math.pow(lng1 - lng2, 2));
            
            // 閾值 0.001 約 100~150公尺，足以切斷所有規劃線產生的異常直線
            if (d > 0.001) {
                if (currentSeg.length > 0) result.push(currentSeg);
                currentSeg = [];
            }
            currentSeg.push(p2);
        }
        if (currentSeg.length > 0) result.push(currentSeg);
        return result;
    };

    // --- 1. 處理多檔案模式圖層顯示 (讓所有 GPX 保持可見但淡化) ---
    let finalColor = customColor || "red"; 
    if (typeof multiGpxStack !== 'undefined' && multiGpxStack.length > 0) {
        // 取得目前操作中的檔案索引
        const stackIdx = (window.currentMultiIndex !== undefined) ? window.currentMultiIndex : 0;
        
        multiGpxStack.forEach((item, i) => {
            const layer = item.layer;
            if (!(layer instanceof L.Polyline)) return;

            // 確保背景圖層也經過斷線處理 (先把舊數據攤平再重新切斷)
            const currentRawPts = layer.getLatLngs().flat(Infinity);
            layer.setLatLngs(breakTracks(currentRawPts)); 

            if (i === stackIdx) {
                // 如果是目前這份檔案
                const isSelectingCombined = (index === 0 || sel.name.includes("結合"));

                if (isSelectingCombined) {
                    // 選中結合版時，隱藏背景原始層，由下方「2. 繪製軌跡」畫出的高亮線取代
                    layer.setStyle({ opacity: 0, weight: 0 });
                } else {
                    // ✅ 選中子路線時，將結合版設為「淡色背景」
                    layer.setStyle({ 
                        color: item.color || "#666", 
                        opacity: 0.5,      
                        weight: 4,          
                        dashArray: "5, 8"   // 虛線區分背景
                    });
                    layer.bringToBack();
                }
                if (item.color) finalColor = item.color;
            } else {
                // ✅ 其他匯入的 GPX 檔案：也要顯示，但更淡一點
                layer.setStyle({ 
                    color: item.color || "#999", 
                    opacity: 0.5, 
                    weight: 4,
                    dashArray: null 
                });
                layer.bringToBack();
            }
        });
    }

    // --- 清除舊的高亮圖層 ---
    if (polyline) map.removeLayer(polyline);
    markers.forEach(m => map.removeLayer(m));
    wptMarkers.forEach(m => map.removeLayer(m));
    if (window.chart) { window.chart.destroy(); window.chart = null; }
    markers = []; wptMarkers = []; polyline = null; 

    // --- 2. 繪製目前選中的高亮軌跡 ---
 if (trackPoints && trackPoints.length > 0) {
        const segments = breakTracks(trackPoints);

        polyline = L.polyline(segments, {
            color: finalColor, weight: 6, opacity: 0.8
        }).addTo(map);

        const checkAndFitBounds = (targetBounds) => {
            if (!targetBounds || !targetBounds.isValid()) return;
            if (!map.getBounds().pad(0.05).intersects(targetBounds)) {
                map.fitBounds(targetBounds, { padding: [20, 20], maxZoom: 16, animate: true });
            }
        };
        checkAndFitBounds(polyline.getBounds());

        // 軌跡點擊邏輯 (維持不變)
        polyline.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            let minD = Infinity, idx = 0;
            trackPoints.forEach((p, pIdx) => {
                const d = Math.sqrt((p.lat - e.latlng.lat)**2 + (p.lon - e.latlng.lng)**2);
                if (d < minD) { minD = d; idx = pIdx; }
            });
            if (minD * 111000 <= 15) {
                if (!hoverMarker) hoverMarker = L.circleMarker([0,0], {radius: 7, color: 'yellow', fillOpacity: 1}).addTo(map);
                hoverMarker.setLatLng([trackPoints[idx].lat, trackPoints[idx].lon]);
                showCustomPopup(idx, "位置資訊");
            }
        });

        // ✅ 修改後的起點與終點標記邏輯
        try {
            const startP = trackPoints[0];
            const startMarker = L.marker([startP.lat, startP.lon], { 
                icon: startIcon,
                zIndexOffset: 1000 
            }).addTo(map);
            
            startMarker.on('click', (e) => {
                L.DomEvent.stopPropagation(e);
                // 只要傳入索引 0，且不傳入 realLat/realLon，就會進入標準軌跡模式顯示時間
                showCustomPopup(0, "起點"); 
            });
            markers.push(startMarker);

            // 終點部分也建議同步
            const lastIdx = trackPoints.length - 1;
            const endMarker = L.marker([trackPoints[lastIdx].lat, trackPoints[lastIdx].lon], { 
                icon: endIcon,
                zIndexOffset: 1000 
            }).addTo(map);
            
            endMarker.on('click', (e) => {
                L.DomEvent.stopPropagation(e);
                showCustomPopup(lastIdx, "終點");
            });
            markers.push(endMarker);
            
        } catch (err) {
            console.error(">>> [ERR] Marker 綁定失敗:", err);
        }

        if (typeof drawElevationChart === 'function') drawElevationChart();
    }

    // --- 3. 繪製航點 ---
    if (sel.waypoints && sel.waypoints.length > 0) {
        sel.waypoints.forEach((w) => {
            let tIdx = 0;
            if (trackPoints.length > 0) {
                let minD = Infinity;
                trackPoints.forEach((tp, pi) => {
                    let d = Math.sqrt((w.lat - tp.lat) ** 2 + (w.lon - tp.lon) ** 2);
                    if (d < minD) { minD = d; tIdx = pi; }
                });
            }
            const wm = L.marker([w.lat, w.lon], { icon: wptIcon }).addTo(map);
            if (showWptNameAlways) {
                wm.bindTooltip(w.name, { permanent: true, direction: 'right', offset: [10, 0], className: 'wpt-label-label' }).openTooltip();
            }
            wm.on('click', (e) => { 
                L.DomEvent.stopPropagation(e); 
                showCustomPopup(tIdx, w.name, null, w.lat, w.lon); 
            });
            wptMarkers.push(wm);
        });
    }

    // --- 4. 最終 UI 更新 ---
    const startLat = (trackPoints.length > 0) ? trackPoints[0].lat : (sel.waypoints?.[0]?.lat || null);
    const startLon = (trackPoints.length > 0) ? trackPoints[0].lon : (sel.waypoints?.[0]?.lon || null);
    if (startLat !== null && startLon !== null) {
        if (!hoverMarker) hoverMarker = L.circleMarker([startLat, startLon], { radius: 6, color: "blue", fillColor: "#fff", fillOpacity: 1, weight: 3 }).addTo(map);
        else hoverMarker.setLatLng([startLat, startLon]).bringToFront();
    }
    if (typeof renderRouteInfo === 'function') renderRouteInfo();
    if (typeof renderWptList === 'function') renderWptList(sel.waypoints);
    
    initProgressBar();
}
 
function toggleWptNames() {
    showWptNameAlways = !showWptNameAlways;
    
    // ✅ 修改這裡：優先使用記錄過的索引，如果完全沒記錄才用 0
    let currentIndex = (window.currentActiveIndex !== undefined) ? window.currentActiveIndex : 0;
    
    
    // ✅ 重新載入「當前」這一條路線，就不會跳回第一條
    loadRoute(currentIndex);
}

window.toggleCompass = function() {
		const compass = document.querySelector(".map-compass");
    if (compass) { compass.classList.toggle("show"); }
};




// ================= 垂直控制項 =================
const CombinedControl = L.Control.extend({
    options: { position: 'topleft' }, 
    onAdd: function (map) {
        const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
        
        const createBtn = (html, title, border) => {
            const btn = L.DomUtil.create('a', '', container);
            btn.innerHTML = html; btn.title = title;
            btn.style.cssText = `font-size:18px; background:white; text-align:center; line-height:30px; width:30px; height:30px; display:block; cursor:pointer; ${border ? 'border-bottom:1px solid #ccc;' : ''}`;
            return btn;
        };

        // 座標轉換
        const coordBtn = createBtn('🌐', '座標轉換', true);

        // 定位按鈕 
		const btnSize = "30px";       // 按鈕方框大小
        const arrowIconSize = "20px"; // 箭頭圖案大小
        const arrowColor = "#1a73e8"; // 箭頭顏色
        const locArrowAngle = "315deg"
        // ------------------------------------------

        const locBtn = L.DomUtil.create('a', '', container);
        locBtn.title = "目前位置定位";
        locBtn.style.cssText = `width:${btnSize}; height:${btnSize}; background:white; cursor:pointer; display:flex; align-items:center; justify-content:center; border-bottom:1px solid #ccc;`;
        
        // 使用 SVG 繪製按鈕內的箭頭圖示
        locBtn.innerHTML = `
            <svg width="${arrowIconSize}" height="${arrowIconSize}" viewBox="0 0 100 100" style="display:block; transform: rotate(${locArrowAngle})">
                <path d="M50 5 L90 90 L50 70 L10 90 Z" fill="${arrowColor}" />
            </svg>
        `;

        // 指北針按鈕
        const compassBtn = createBtn('🧭', '顯示/隱藏指北針', false);

        L.DomEvent.disableClickPropagation(container);
        
/// 座標定位按鈕點擊事件
        L.DomEvent.on(coordBtn, 'click', (e) => { 
            L.DomEvent.stop(e); 
            
            
            // 1. 清除地圖上的定位點邏輯 (維持不變)
            if (hoverMarker) {
                map.removeLayer(hoverMarker);
                hoverMarker = null; 
            }

            map.eachLayer((layer) => {
                if (layer instanceof L.Marker || layer instanceof L.CircleMarker) {
                    if (layer.getPopup()) {
                        const content = layer.getPopup().getContent();
                        if (typeof content === 'string' && content.includes('定位點資訊')) {
                            map.removeLayer(layer);
                        }
                    }
                }
            });

            // --- 關鍵修正：確保 Modal 在全螢幕下可見 ---
            const modal = document.getElementById('coordModal');
            const mapContainer = document.getElementById('map');
            
            // 如果 Modal 不在地圖容器內，就把它搬進去
            if (modal.parentNode !== mapContainer) {
                mapContainer.appendChild(modal);
            }
            
						L.DomEvent.disableClickPropagation(modal);

            // 強制設定 Modal 的層級與定位，確保它在全螢幕最上層
            modal.style.zIndex = "2147483647"; // 使用最大值
            modal.style.position = "absolute";
            modal.style.display = 'flex'; 
            // ------------------------------------------

            // 在 input 標籤中加入 onkeydown="if(event.keyCode==13) executeJump('...')"
modal.innerHTML = `
    <div id="jump-container" style="background:white; padding:12px 15px; border-radius:12px; width:280px; box-shadow:0 10px 25px rgba(0,0,0,0.5); font-family: sans-serif; font-size:13px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
            <b style="color:#1a73e8;">🌐 座標跳轉定位</b>
            <span onclick="document.getElementById('coordModal').style.display='none'" style="cursor:pointer; font-size:20px; color:#999;">&times;</span>
        </div>

        <div style="border:1px solid #eee; padding:8px; border-radius:8px; margin-bottom:10px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                <label style="font-weight:bold;">WGS84 (GPS)</label>
                <select id="wgs_type" onchange="toggleWgsInput()" style="font-size:11px; padding:2px;">
                    <option value="DD">十進位度</option>
                    <option value="DMS">度分秒</option>
                </select>
            </div>

            <div id="wgs_dd_input" style="display:flex; gap:5px;">
                <input type="number" id="lat_dd" placeholder="緯度" onkeydown="if(event.keyCode==13) executeJump('WGS')" style="width:50%; padding:6px; border:1px solid #ccc; border-radius:4px;">
                <input type="number" id="lng_dd" placeholder="經度" onkeydown="if(event.keyCode==13) executeJump('WGS')" style="width:50%; padding:6px; border:1px solid #ccc; border-radius:4px;">
            </div>

            <div id="wgs_dms_input" style="display:none; flex-direction:column; gap:8px;">
                <div style="display:flex; gap:3px; align-items:center;">
                    <span style="width:15px; font-weight:bold; color:#666;">緯</span>
                    <input type="number" id="lat_d" placeholder="度°" onkeydown="if(event.keyCode==13) executeJump('WGS')" style="width:30%; padding:5px; border:1px solid #ccc;">
                    <input type="number" id="lat_m" placeholder="分'" onkeydown="if(event.keyCode==13) executeJump('WGS')" style="width:30%; padding:5px; border:1px solid #ccc;">
                    <input type="number" id="lat_s" placeholder="秒&quot;" onkeydown="if(event.keyCode==13) executeJump('WGS')" style="width:35%; padding:5px; border:1px solid #ccc;">
                </div>
                <div style="display:flex; gap:3px; align-items:center;">
                    <span style="width:15px; font-weight:bold; color:#666;">經</span>
                    <input type="number" id="lng_d" placeholder="度°" onkeydown="if(event.keyCode==13) executeJump('WGS')" style="width:30%; padding:5px; border:1px solid #ccc;">
                    <input type="number" id="lng_m" placeholder="分'" onkeydown="if(event.keyCode==13) executeJump('WGS')" style="width:30%; padding:5px; border:1px solid #ccc;">
                    <input type="number" id="lng_s" placeholder="秒&quot;" onkeydown="if(event.keyCode==13) executeJump('WGS')" style="width:35%; padding:5px; border:1px solid #ccc;">
                </div>
            </div>
            <button onclick="executeJump('WGS')" style="width:100%; margin-top:10px; background:#1a73e8; color:white; border:none; padding:7px; border-radius:4px; cursor:pointer; font-weight:bold;">確認 WGS84 定位</button>
        </div>

        <div style="border:1px solid #eee; padding:8px; border-radius:8px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                <select id="twd_system" style="font-weight:bold; border:none; background:none; cursor:pointer; color:#34a853; font-size:13px;">
                    <option value="97">TWD97</option>
                    <option value="67">TWD67</option>
                </select>
                <span style="font-size:10px; color:#999;">X (橫) / Y (縱)</span>
            </div>
            <div style="display:flex; gap:5px;">
                <input type="number" id="twd_x" placeholder="X 座標" onkeydown="if(event.keyCode==13) executeJump('TWD')" style="width:50%; padding:6px; border:1px solid #ccc; border-radius:4px;">
                <input type="number" id="twd_y" placeholder="Y 座標" onkeydown="if(event.keyCode==13) executeJump('TWD')" style="width:50%; padding:6px; border:1px solid #ccc; border-radius:4px;">
            </div>
            <p style="font-size:10px; color:#ea4335; margin:2px 0 0 2px;">* 至少輸入X前四位數，Y前五位數</p>
            <button onclick="executeJump('TWD')" style="width:100%; margin-top:10px; background:#34a853; color:white; border:none; padding:7px; border-radius:4px; cursor:pointer; font-weight:bold;">確認 TWD 定位</button>
        </div>
    </div>
`;

// 輔助 UI 切換函式
window.toggleWgsInput = function() {
    const type = document.getElementById('wgs_type').value;
    document.getElementById('wgs_dd_input').style.display = (type === 'DD') ? 'flex' : 'none';
    document.getElementById('wgs_dms_input').style.display = (type === 'DMS') ? 'flex' : 'none';
};

            // 自動聚焦
            setTimeout(() => document.getElementById('jump_wgs').focus(), 100);
        });

        L.DomEvent.on(locBtn, 'click', (e) => { 
            L.DomEvent.stop(e); 
            window.toggleGPS(locBtn); // 呼叫下方新增的切換函式
        });

        L.DomEvent.on(compassBtn, 'click', (e) => { 
            L.DomEvent.stop(e); 
            document.getElementById("mapCompass").classList.toggle("show"); 
        });
        
        return container;
    }
});
map.addControl(new CombinedControl());

let gpsInterval = null;
let gpsButtonElement = null;

window.toggleGPS = function(btn) {
    gpsButtonElement = btn; 

    // 如果計時器或標記已存在 -> 執行「關閉定位」
    if (gpsInterval || gpsMarker) {
        if (gpsInterval) {
            clearInterval(gpsInterval);
            gpsInterval = null;
        }
        if (gpsMarker) {
            map.removeLayer(gpsMarker);
            gpsMarker = null;
        }
        btn.style.background = "white"; // 還原按鈕顏色
        return;
    }

    if (!navigator.geolocation) {
        alert("您的瀏覽器不支援 GPS 定位功能");
        return;
    }

    // 定義一個執行定位的內部函式
    const runLocation = (isFirstTime = false) => {
        navigator.geolocation.getCurrentPosition((pos) => {
            const lat = pos.coords.latitude;
            const lon = pos.coords.longitude;
            
            // 轉換座標
            const twd97 = proj4(WGS84_DEF, TWD97_DEF, [lon, lat]);
            const twd67 = proj4(WGS84_DEF, TWD67_DEF, [lon, lat]);

            // 1. 每次更新都將地圖中心移至目前位置
            map.setView([lat, lon], map.getZoom());
            btn.style.background = "#e8f0fe"; 

            // 2. 更新或建立自定義箭頭
            const arrowIcon = L.divIcon({
                className: 'custom-gps-arrow',
                html: `<div style="transform: rotate(315deg); display: flex; justify-content: center;">
                         <svg width="40" height="40" viewBox="0 0 100 100">
                           <path d="M50 5 L95 90 L50 70 L5 90 Z" fill="#1a73e8" stroke="white" stroke-width="5"/>
                         </svg>
                       </div>`,
                iconSize: [40, 40],
                iconAnchor: [20, 20]
            });

            if (gpsMarker) {
                gpsMarker.setLatLng([lat, lon]);
            } else {
                gpsMarker = L.marker([lat, lon], { icon: arrowIcon }).addTo(map);
            }

            // --- 修改部分：更新為立體圖片按鈕 ---
            const gUrl = `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
            const gMapIconBtn = `
                <a href="${gUrl}" target="_blank" title="於 Google Map 開啟導航" 
                   style="text-decoration:none; margin-right:8px; display:inline-flex; align-items:center; justify-content:center; width: 28px; height: 28px; background: #fff; border: 1px solid #ccc; border-radius: 50%; box-shadow: 0 2px 4px rgba(0,0,0,0.2); vertical-align: middle;">
                    <img src="https://ychiking.github.io/gpx-online-viewer/GoogleMaps.png" style="width:18px; height:18px; display:block;" alt="GMap">
                </a>`;
            
            const tipText = `
                <div style="font-size:13px; line-height:1.6; min-width:200px;">
                    <div style="display:flex; align-items:center;">
                        ${gMapIconBtn}
                        <b style="color:#d35400; font-size:14px;">目前位置 (自動追蹤中)</b>
                    </div>
                    <hr style="margin:5px 0; border:0; border-top:1px solid #eee;">
                    <b>WGS84:</b> ${lat.toFixed(6)}, ${lon.toFixed(6)}<br>
                    <b>TWD97:</b> ${Math.round(twd97[0])}, ${Math.round(twd97[1])}<br>
                    <b>TWD67:</b> ${Math.round(twd67[0])}, ${Math.round(twd67[1])}
                    
                    <div style="display:flex; margin-top:10px; gap:8px;">
                        <button onclick="setFreeAB('A', ${lat}, ${lon})" style="flex:1; background:#007bff; color:white; border:none; padding:6px; border-radius:4px; cursor:pointer; font-weight:bold;">設定 A</button>
                        <button onclick="setFreeAB('B', ${lat}, ${lon})" style="flex:1; background:#e83e8c; color:white; border:none; padding:6px; border-radius:4px; cursor:pointer; font-weight:bold;">設定 B</button>
                    </div>
            
                    <hr style="margin: 8px 0; border: 0; border-top: 1px solid #eee;">
                    <div style="color: #d35400; font-size: 10px; background: #fff5eb; padding: 4px; border-radius: 4px;">
                        ⚠️ 自動追蹤中，每 30 秒更新一次中心位置。
                    </div>
                </div>
            `;
            // --- 修改結束 ---

            if (isFirstTime || (gpsMarker.getPopup() && gpsMarker.getPopup().isOpen())) {
                gpsMarker.bindPopup(tipText).openPopup();
            } else {
                gpsMarker.bindPopup(tipText);
            }

        }, (err) => {
            console.warn("定位失敗:", err);
            if (isFirstTime) alert("無法獲取位置，請確認 GPS 已開啟");
        }, { enableHighAccuracy: true });
    };

    // 立即啟動第一次定位
    runLocation(true);

    // 設定每 30 秒自動更新
    gpsInterval = setInterval(() => {
        runLocation(false);
    }, 30000);
};

window.resetGPS = function() {
    if (gpsMarker) {
        map.removeLayer(gpsMarker);
        gpsMarker = null;
    }

    const locBtn = document.querySelector('a[title="目前位置定位"]');
    if (locBtn) {
        locBtn.style.background = "white";
    }
};


// ================= 座標轉換 TIP 邏輯 =================
const TWD97_DEF = "+proj=tmerc +lat_0=0 +lon_0=121 +k=0.9999 +x_0=250000 +y_0=0 +ellps=GRS80 +units=m +no_defs";
const TWD67_DEF = "+proj=tmerc +lat_0=0 +lon_0=121 +k=0.9999 +x_0=250000 +y_0=0 +ellps=aust_SA +towgs84=-752,-358,-179,0,0,0,0 +units=m +no_defs";
const WGS84_DEF = "EPSG:4326";

window.clearCoordInputs = function() {
    document.getElementById('wgs_input').value = "";
    document.getElementById('twd_input').value = "";
    window.showMsg('res_twd97', "結果顯示在此 (點擊可複製)");
    window.showMsg('res_wgs84', "結果顯示在此 (點擊可複製)");
};


window.showMsg = function(id, text, type = 'normal') {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = text;
    el.classList.remove('error-text', 'copy-success');
    if (type === 'error') el.classList.add('error-text');
    if (type === 'success') el.classList.add('copy-success');
};

window.getLocation = function() {
    if (!navigator.geolocation) { showMsg('res_twd97', "不支援定位", 'error'); return; }
    showMsg('res_twd97', "🔍 正在獲取 GPS...");
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            document.getElementById('wgs_input').value = `${pos.coords.latitude.toFixed(6)}, ${pos.coords.longitude.toFixed(6)}`;
            window.toTWD97();
        },
        (err) => { showMsg('res_twd97', "定位失敗 (權限或訊號)", 'error'); },
        { enableHighAccuracy: true, timeout: 8000 }
    );
};

window.toTWD97 = function() {
    try {
        const val = document.getElementById('wgs_input').value;
        const pts = val.replace(/[^\d.\-, ]/g, ' ').trim().split(/[\s,]+/).map(parseFloat);
        if (pts.length < 2 || isNaN(pts[0])) throw "格式錯誤";
        const res = proj4(WGS84_DEF, TWD97_DEF, [pts[1], pts[0]]);
        showMsg('res_twd97', `TWD97 (X,Y): <b>${Math.round(res[0])}, ${Math.round(res[1])}</b>`);
    } catch (e) { showMsg('res_twd97', "輸入錯的座標", 'error'); }
};

window.toWGS84 = function() {
    try {
        const val = document.getElementById('twd_input').value;
        const pts = val.replace(/[^\d.\-, ]/g, ' ').trim().split(/[\s,]+/).map(parseFloat);
        if (pts.length < 2 || isNaN(pts[0])) throw "格式錯誤";
        const res = proj4(TWD97_DEF, WGS84_DEF, [pts[0], pts[1]]);
        showMsg('res_wgs84', `WGS84 (緯度,經度): <b>${res[1].toFixed(6)}°, ${res[0].toFixed(6)}°</b>`);
    } catch (e) { showMsg('res_wgs84', "輸入錯的座標", 'error'); }
};

window.copyText = function(id) {
    const el = document.getElementById(id);
    const text = el.innerText;
    if (text.includes(': ')) {
        const content = text.split(': ')[1];
        const oldHtml = el.innerHTML;
        navigator.clipboard.writeText(content).then(() => {
            showMsg(id, "✅ 已複製", 'success');
            setTimeout(() => { showMsg(id, oldHtml); el.classList.remove('copy-success'); }, 1500);
        }).catch(() => showMsg(id, "複製失敗", 'error'));
    }
};

function showCustomPopup(idx, title, offPathEle = null, realLat = null, realLon = null) {
  const isWaypoint = (realLat !== null && realLon !== null);
  
  if (!isWaypoint && (!trackPoints || !trackPoints[idx])) {
    return;
  }

  const p = trackPoints[idx] || {}; 
  const lat = isWaypoint ? realLat : p.lat;
  const lon = isWaypoint ? realLon : p.lon;
  
  // ✅ 尋找純航點的時間資料
  let waypointTime = null;
  if (isWaypoint) {
      const activeIdx = (typeof window.currentMultiIndex !== 'undefined') ? window.currentMultiIndex : 0;
      const currentGpx = allTracks[activeIdx];

      if (currentGpx && currentGpx.waypoints) {
          const wptData = currentGpx.waypoints.find(w => 
              Math.abs(w.lat - lat) < 0.000001 && Math.abs(w.lon - lon) < 0.000001
          );

          if (wptData && wptData.localTime && wptData.localTime !== "無時間資訊") {
              waypointTime = wptData.localTime;
          }
      }
  }

  const gUrl = `https://www.google.com/maps?q=${lat},${lon}`;
  let targetLatLng = [lat, lon];
  
  if (typeof hoverMarker !== 'undefined' && hoverMarker) {
    if (lat !== undefined && lon !== undefined) {
      hoverMarker.setLatLng([lat, lon]).bringToFront();
    }
  }

  const gMapIconBtn = `
    <a href="${gUrl}" target="_blank" title="於 Google Map 開啟" 
       style="text-decoration:none; margin-right:8px; display:inline-flex; align-items:center; justify-content:center; width: 28px; height: 28px; background: #fff; border: 1px solid #ccc; border-radius: 50%; box-shadow: 0 2px 4px rgba(0,0,0,0.2); vertical-align: middle;">
        <img src="https://ychiking.github.io/gpx-online-viewer/GoogleMaps.png" style="width:18px; height:18px; display:block;" alt="GMap">
    </a>`;

  let content = "";
  const noTrackData = (offPathEle !== null || (idx !== 0 && !p.distance));

  // --- 關鍵修改：將 lat, lon 傳入 setAB 函式 ---
  // 這樣當點擊航點時，setAB 就會收到精確座標而不是路徑座標
  const abButtons = `
    <div style="display:flex; margin-top:10px; gap:5px;">
      <button onclick="setAB('A', ${idx}, ${lat}, ${lon})" style="flex:1; background:#007bff; color:white; border:none; padding:6px; border-radius:4px; cursor:pointer; font-weight:bold;">設定 A</button>
      <button onclick="setAB('B', ${idx}, ${lat}, ${lon})" style="flex:1; background:#e83e8c; color:white; border:none; padding:6px; border-radius:4px; cursor:pointer; font-weight:bold;">設定 B</button>
    </div>`;

  if (noTrackData) {
      const currentEle = offPathEle || (p.ele ? p.ele.toFixed(0) : "---");
      const twd97 = proj4(WGS84_DEF, TWD97_DEF, [lon, lat]);
      const twd67 = proj4(WGS84_DEF, TWD67_DEF, [lon, lat]);

      content = `
        <div style="min-width:160px; font-size:13px; line-height:1.6;">
          <div style="display:flex; align-items:center; margin-bottom:5px;">
            ${gMapIconBtn}
            <b style="font-size:14px; color: #1a73e8;">${title}</b>
          </div>
          高度: ${currentEle} m<br>
          ${waypointTime ? `時間: ${waypointTime}<br>` : ''} 
          WGS84: ${lat.toFixed(5)}, ${lon.toFixed(5)}<br>
          TWD97: ${Math.round(twd97[0])}, ${Math.round(twd97[1])}<br>
          TWD67: ${Math.round(twd67[0])}, ${Math.round(twd67[1])}<br>
          ${offPathEle !== null ? '<span style="color:red; font-weight:bold;">⚠️ 不在路徑上</span>' : ''}
          ${abButtons}
        </div>`;
      
      targetLatLng = [lat, lon];
  } else {
      const twd97 = proj4(WGS84_DEF, TWD97_DEF, [p.lon, p.lat]);
      const twd67 = proj4(WGS84_DEF, TWD67_DEF, [p.lon, p.lat]); 
      
      content = `
        <div style="min-width:180px; font-size:13px; line-height:1.5;">
          <div style="display:flex; align-items:center; margin-bottom:5px;">
            ${gMapIconBtn}
            <b style="font-size:14px; color: #1a73e8;">${title}</b>
          </div>
          高度: ${p.ele.toFixed(0)} m<br>
          距離: ${p.distance.toFixed(2)} km<br>
          時間: ${p.timeLocal}<br>
          WGS84: ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}<br>
          TWD97: ${Math.round(twd97[0])}, ${Math.round(twd97[1])}<br>
          TWD67: ${Math.round(twd67[0])}, ${Math.round(twd67[1])}
          ${abButtons}
        </div>`;
  }

  if (currentPopup && map.hasLayer(currentPopup)) {
    currentPopup.setLatLng(targetLatLng).setContent(content);
  } else {
    currentPopup = L.popup({ autoClose: true, closeOnClick: false, fadeAnimation: false })
    .setLatLng(targetLatLng).setContent(content).openOn(map);
  }
}

function startHeightTipTimer() {
  if (mapTipTimer) clearTimeout(mapTipTimer);
  mapTipTimer = setTimeout(() => {
    if (currentPopup && map.hasLayer(currentPopup)) {
      const el = currentPopup.getElement();
      if (el && el.innerText.includes("位置資訊")) { map.closePopup(); }
    }
  }, 3000);
}


// ================= 高度圖 =================
let mouseX = null; 

function drawElevationChart() {
    const canvas = document.getElementById("elevationChart");
    const ctx = canvas.getContext("2d");
    if (chart) chart.destroy();

    const _handleSync = (e) => {
    const points = chart.getElementsAtEventForMode(e, 'index', { intersect: false }, true);
    if (points.length) {
        const idx = points[0].index;
        const p = trackPoints[idx];
        window.lastHoverIdx = idx;

        // 1. 位置資訊顯示邏輯
        const checkbox = document.getElementById("showChartTipCheckbox");
        const isChecked = checkbox ? checkbox.checked : true;

        if (isChecked) {
            // 這裡傳入 "位置資訊" 作為標題，並確保彈窗開啟
            showCustomPopup(idx, "位置資訊");
        }

        // 2. 更新小藍點位置
        if (hoverMarker) {
            const newLatLng = [p.lat, p.lon];
            hoverMarker.setLatLng(newLatLng).bringToFront();

            // 3. 地圖自動隨動邏輯
            // 取得地圖目前的邊界
            const bounds = map.getBounds();
            // 如果小藍點座標不在目前的視窗範圍內
            if (!bounds.contains(newLatLng)) {
                // 平滑移動地圖中心到小藍點位置
                map.panTo(newLatLng, { animate: true, duration: 0.5 });
            }
        }

        // 4. 更新圖表狀態 (Tooltip 與 Active Element)
        chart.setActiveElements([{ datasetIndex: 0, index: idx }]);
        chart.tooltip.setActiveElements([{ datasetIndex: 0, index: idx }], { x: 0, y: 0 });
        chart.update('none');

        // 5. 自動消失計時器 (如果需要滑動停住後消失)
        if (window.chartTipTimer) clearTimeout(window.chartTipTimer);
        window.chartTipTimer = setTimeout(() => {
            if (chart) { 
                chart.tooltip.setActiveElements([], { x: 0, y: 0 }); 
                chart.update('none'); 
            }
            // 如果 user 沒在拖動了，可以選擇是否關閉彈窗
            // if (currentPopup) map.closePopup(); 
        }, 3000);
    }
  };

    const onMouseDown = (e) => { if (e.button === 0) { isMouseDown = true; if (window.mapTipTimer) clearTimeout(window.mapTipTimer); _handleSync(e); } };
    const onTouchStart = (e) => { isMouseDown = true; if (window.mapTipTimer) clearTimeout(window.mapTipTimer); _handleSync(e); if (e.cancelable) e.preventDefault(); };
    const onTouchMove = (e) => { if (isMouseDown) { _handleSync(e); if (e.cancelable) e.preventDefault(); } };
    const onMouseMove = (e) => { 
        const rect = canvas.getBoundingClientRect(); mouseX = e.clientX - rect.left;
        if (isMouseDown) { _handleSync(e); } else {
            if (chart && chart.getActiveElements().length > 0) { chart.tooltip.setActiveElements([], { x: 0, y: 0 }); chart.update('none'); }
        }
    };
    const onMouseLeave = () => { mouseX = null; if (isMouseDown) { isMouseDown = false; if (typeof startHeightOnlyTimer === "function") startHeightOnlyTimer(); } if (chart) { chart.tooltip.setActiveElements([], { x: 0, y: 0 }); chart.update('none'); } };
    const onEnd = () => { if (isMouseDown) { isMouseDown = false; if (typeof startHeightOnlyTimer === "function") startHeightOnlyTimer(); } if (chart) { chart.tooltip.setActiveElements([], { x: 0, y: 0 }); chart.update('none'); } };

    canvas.replaceWith(canvas.cloneNode(true)); 
    const newCanvas = document.getElementById("elevationChart");
    const newCtx = newCanvas.getContext("2d");

    newCanvas.addEventListener('mousedown', onMouseDown);
    newCanvas.addEventListener('touchstart', onTouchStart, { passive: false });
    newCanvas.addEventListener('touchmove', onTouchMove, { passive: false });
    newCanvas.addEventListener('mousemove', onMouseMove);
    newCanvas.addEventListener('mouseleave', onMouseLeave);
    newCanvas.addEventListener('touchend', onEnd);

    window.removeEventListener('mouseup', onEnd); 
    window.addEventListener('mouseup', onEnd);

    // 強制展開容器
    const chartContainer = document.getElementById('chartContainer');
    chartContainer.style.display = 'block';
    
    // 初始化 Checkbox 顯示邏輯
    const tipLabel = document.getElementById("chartTipToggleLabel");
    if (tipLabel) {
        // 只有在「有航跡」且「高度表展開」時顯示
        const hasTracks = trackPoints && trackPoints.length > 0;
        tipLabel.style.display = hasTracks ? "flex" : "none";
    }

    chart = new Chart(newCtx, {
        type: "line",
        data: {
            labels: trackPoints.map(p => p.distance.toFixed(2)),
            datasets: [{ 
                label: "高度 (m)", data: trackPoints.map(p => p.ele), fill: true, 
                backgroundColor: 'rgba(54, 162, 235, 0.2)', borderColor: 'rgba(54, 162, 235, 1)', tension: 0.1, 
                pointRadius: 0, pointHitRadius: 10, pointHoverRadius: 8, pointHoverBackgroundColor: 'rgba(54, 162, 235, 0.8)', pointHoverBorderWidth: 2, pointHoverBorderColor: '#fff'
            }]
        },
        options: {
            animation: false,
            responsive: true, maintainAspectRatio: false,
            events: ['mousedown', 'mouseup', 'click', 'touchstart', 'touchmove', 'touchend'],
            interaction: { intersect: false, mode: "index" },
            hover: { mode: 'index', intersect: false },
            plugins: {
                tooltip: {
                    enabled: true, displayColors: false, 
                    filter: () => isMouseDown || (chart && chart.getActiveElements().length > 0),
                    callbacks: {
                        title: () => "位置資訊", 
                        label: function(context) {
                            const p = trackPoints[context.dataIndex];
                            return [` ■ 距離: ${p.distance.toFixed(2)} km`, ` ■ 高度: ${p.ele.toFixed(0)} m`, ` ■ 時間: ${p.timeLocal ? p.timeLocal.split(' ')[1] : ''}`];
                        }
                    }
                }
            }
        },
        plugins: [{
            id: 'verticalLine',
            afterDraw: (chart) => {
                if (mouseX !== null) {
                    const x = mouseX; const topY = chart.chartArea.top; const bottomY = chart.chartArea.bottom; const _ctx = chart.ctx;
                    _ctx.save(); _ctx.beginPath(); _ctx.moveTo(x, topY); _ctx.lineTo(x, bottomY);
                    _ctx.lineWidth = 1; _ctx.strokeStyle = isMouseDown ? 'rgba(0, 123, 255, 0.8)' : 'rgba(150, 150, 150, 0.4)';
                    _ctx.setLineDash(isMouseDown ? [] : [5, 5]); _ctx.stroke();
                    if (!isMouseDown) { _ctx.fillStyle = 'rgba(150, 150, 150, 0.8)'; _ctx.font = '10px Arial'; _ctx.fillText(' 按住拖動 ', x + 5, topY + 15); }
                    _ctx.restore();
                }
            }
        }]
    });
}

document.addEventListener('change', function(e) {
    if (e.target && e.target.id === 'showChartTipCheckbox') {
        if (e.target.checked) {
            // 如果開啟且有紀錄過索引，立即顯示
            if (window.lastHoverIdx !== null) {
                showCustomPopup(window.lastHoverIdx, "位置資訊");
            }
        } else {
            // 如果關閉，立即移除地圖上的彈窗
            if (currentPopup) map.closePopup();
        }
    }
});

  function handleSync(e) {
    const points = chart.getElementsAtEventForMode(e, 'index', { intersect: false }, true);
    if (points.length) {
      const idx = points[0].index;
      const p = trackPoints[idx];
      hoverMarker.setLatLng([p.lat, p.lon]);
      showCustomPopup(idx, "位置資訊");
      chart.setActiveElements([{ datasetIndex: 0, index: idx }]);
      chart.tooltip.setActiveElements([{ datasetIndex: 0, index: idx }], { x: 0, y: 0 });
      chart.update('none');
      if (window.chartTipTimer) clearTimeout(window.chartTipTimer);
      if (isMouseDown) {
        window.chartTipTimer = setTimeout(() => {
          if (chart) { chart.tooltip.setActiveElements([], { x: 0, y: 0 }); chart.update('none'); }
        }, 3000);
      }
    }
  }

function startHeightOnlyTimer() {
  if (mapTipTimer) clearTimeout(mapTipTimer);
  mapTipTimer = setTimeout(() => {
    if (currentPopup && map.hasLayer(currentPopup)) {
      const content = currentPopup.getContent();
      if (typeof content === 'string' && content.includes("位置資訊")) { map.closePopup(); }
    }
  }, 3000);
}

// ================= 航點導向功能 =================
window.focusWaypoint = function(lat, lon, name, distToTrack = 0, ele = null) {
    map.closePopup();
    map.setView([lat, lon], 16);
    
    let minD = Infinity, idx = 0;
    
    if (trackPoints && trackPoints.length > 0) {
        trackPoints.forEach((tp, i) => {
            let d = Math.sqrt((lat - tp.lat) ** 2 + (lon - tp.lon) ** 2);
            if (d < minD) { minD = d; idx = i; }
        });
    }

    if (hoverMarker) { 
        hoverMarker.setLatLng([lat, lon]).bringToFront(); 
    }

    // 關鍵修正：無論是否為純航點，都把原始的 lat, lon 傳給彈窗
    // 這樣彈窗產生的 "設為A點" 按鈕就能拿到精確座標
    showCustomPopup(idx, name, ele, lat, lon);
    
    if (chart && trackPoints.length > 0) {
        chart.setActiveElements([{ datasetIndex: 0, index: idx }]);
        chart.update('none');
    }
    
    document.getElementById("map").scrollIntoView({ behavior: 'smooth' });
};

// ================= A/B 設定與資訊渲染 =================
window.setAB = function(type, idx, forcedLat = null, forcedLon = null) {
  let lat, lon, targetPoint;
  
  // 1. 取得座標邏輯
  if (forcedLat !== null && forcedLon !== null) {
    // ✅ 優先使用傳入的精確座標 (航點原始座標)
    lat = forcedLat;
    lon = forcedLon;
    
    // 同時保留索引資訊，以便計算 A-B 之間的距離與時間
    if (trackPoints && trackPoints[idx]) {
      targetPoint = { ...trackPoints[idx], lat, lon, idx }; 
    } else {
      targetPoint = { lat, lon, idx, ele: 0 };
    }
  } else if (trackPoints && trackPoints[idx]) {
    // 從高度表或軌跡點點擊時
    targetPoint = { ...trackPoints[idx], idx };
    lat = targetPoint.lat;
    lon = targetPoint.lon;
  } else if (hoverMarker) {
    const pos = hoverMarker.getLatLng();
    lat = pos.lat;
    lon = pos.lng;
    targetPoint = { lat, lon, idx, ele: 0 };
  } else {
    return;
  }

  // 2. 設定 A 或 B 點
  if (type === 'A') {
    pointA = targetPoint;
    if (markerA) map.removeLayer(markerA);
    markerA = L.marker([lat, lon], { 
      icon: L.divIcon({ 
        html: `<div style="background:#007bff;color:white;border-radius:50%;width:24px;height:24px;text-align:center;line-height:24px;font-weight:bold;border:2px solid white;">A</div>`, 
        iconSize:[24,24], iconAnchor:[12,12], className:'' 
      }) 
    }).addTo(map);
  } else {
    pointB = targetPoint;
    if (markerB) map.removeLayer(markerB);
    markerB = L.marker([lat, lon], { 
      icon: L.divIcon({ 
        html: `<div style="background:#e83e8c;color:white;border-radius:50%;width:24px;height:24px;text-align:center;line-height:24px;font-weight:bold;border:2px solid white;">B</div>`, 
        iconSize:[24,24], iconAnchor:[12,12], className:'' 
      }) 
    }).addTo(map);
  }

  updateABUI(); 
  map.closePopup(); 
};

function updateABUI() {
    const infoA = document.getElementById("infoA"), infoB = document.getElementById("infoB"), boxRes = document.getElementById("boxRes"), infoRes = document.getElementById("infoRes");
    
    const getCoordHTML = (p) => {
        const twd97 = proj4(WGS84_DEF, TWD97_DEF, [p.lon, p.lat]);
        const twd67 = proj4(WGS84_DEF, TWD67_DEF, [p.lon, p.lat]);
        return `WGS84: ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}<br>
                TWD97: ${Math.round(twd97[0])}, ${Math.round(twd97[1])}<br>
                TWD67: ${Math.round(twd67[0])}, ${Math.round(twd67[1])}`;
    };

    // --- 更新 A 點資訊顯示 ---
// --- 更新 A 點資訊顯示 ---
    if (pointA) {
        let html = getCoordHTML(pointA);
        // ✅ 修正：除了檢查 idx，也要確保屬性存在才能用 toFixed
        if (pointA.idx !== -1 && pointA.ele !== undefined && pointA.distance !== undefined) {
            html += `<br><span style="color:#666;">高度: ${pointA.ele.toFixed(0)}m, 里程: ${pointA.distance.toFixed(2)}km, ${pointA.timeLocal || ""}</span>`;
        } else if (pointA.ele !== undefined) {
            // 如果是純航點但有高度資訊
            html += `<br><span style="color:#666;">高度: ${pointA.ele.toFixed(0)}m</span>`;
        }
        infoA.innerHTML = html;
    } else {
        infoA.innerHTML = "尚未設定";
    }

    // --- 更新 B 點資訊顯示 ---
    if (pointB) {
        let html = getCoordHTML(pointB);
        // ✅ 修正：同上，加入安全檢查
        if (pointB.idx !== -1 && pointB.ele !== undefined && pointB.distance !== undefined) {
            html += `<br><span style="color:#666;">高度: ${pointB.ele.toFixed(0)}m, 里程: ${pointB.distance.toFixed(2)}km, ${pointB.timeLocal || ""}</span>`;
        } else if (pointB.ele !== undefined) {
            html += `<br><span style="color:#666;">高度: ${pointB.ele.toFixed(0)}m</span>`;
        }
        infoB.innerHTML = html;
    } else {
        infoB.innerHTML = "尚未設定";
    }

    // --- 區間分析邏輯 ---
    if (pointA && pointB) {
        boxRes.style.display = "block";
        const bearing = getBearingInfo(pointA.lat, pointA.lon, pointB.lat, pointB.lon);
        
        const R = 6371; 
        const dLat = (pointB.lat - pointA.lat) * Math.PI / 180;
        const dLon = (pointB.lon - pointA.lon) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(pointA.lat * Math.PI / 180) * Math.cos(pointB.lat * Math.PI / 180) *
                  Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const directDist = R * c;

        let analysisContent = "";

        // 判斷是否兩點都在路徑上 (idx 不等於 -1 代表是在路徑上)
        const isBothOnPath = (pointA.idx !== -1 && pointB.idx !== -1);
        let slopeText = "";

				if (isBothOnPath) {
            // 兩點都在路徑上，計算平均坡度
            const hDiff = pointB.ele - pointA.ele; // 高度差
            const dDiff = Math.abs(pointB.distance - pointA.distance) * 1000; // 沿路距離(公尺)
            
            if (dDiff > 0) {
                const slope = (hDiff / dDiff) * 100;
                // 使用 Math.abs(slope) 移除負號
                const absSlope = Math.abs(slope).toFixed(1);
                
                if (slope > 0) {
                    // 上坡：橘紅色，標註 (上坡)
                    slopeText = `<br>平均坡度：<b style="color:#d35400;">${absSlope} % (上坡)</b>`;
                } else if (slope < 0) {
                    // 下坡：綠色，標註 (下坡)
                    slopeText = `<br>平均坡度：<b style="color:#28a745;">${absSlope} % (下坡)</b>`;
                } else {
                    slopeText = `<br>平均坡度：<b>0.0 %</b>`;
                }
            } else {
                slopeText = `<br>平均坡度：<b>0.0 %</b>`;
            }
        } else {
            // 其中一點不是路徑點
            slopeText = `<br>平均坡度：<span style="color:#888;">無高度資訊</span>`;
        }

        if (pointA.idx === -1 || pointB.idx === -1) {
            // --- 狀況 1: 直線分析 ---
            analysisContent = `
                <div style="color:#d35400; font-weight:bold; margin-bottom:4px;">📍 直線分析 (非全路徑點)</div>
                直線距離：<b>${directDist.toFixed(2)} km</b>${slopeText}<br>
                移動方位：<span style="color:#007bff; font-weight:bold;">往 ${bearing.name} (${bearing.deg}°)</span>`;
        } else {
            // --- 狀況 2: 沿路區間分析 ---
            const start = Math.min(pointA.idx, pointB.idx), end = Math.max(pointA.idx, pointB.idx);
            const section = trackPoints.slice(start, end + 1);
            const { gain, loss } = calculateElevationGainFiltered(section);
            const timeDiff = Math.abs(pointA.timeUTC - pointB.timeUTC);
            
            analysisContent = `
                區間爬升：<b>${gain.toFixed(0)} m</b> / 下降：<b>${loss.toFixed(0)} m</b>${slopeText}<br>
                沿路距離：<b>${Math.abs(pointA.distance - pointB.distance).toFixed(2)} km</b><br>
                直線距離：<b>${directDist.toFixed(2)} km</b><br>
                時　　間：<b>${Math.floor(timeDiff/3600000)} 小時 ${Math.floor((timeDiff%3600000)/60000)} 分鐘</b><br>
                移動方位：<span style="color:#007bff; font-weight:bold;">往 ${bearing.name} (${bearing.deg}°)</span>`;
        }

        infoRes.innerHTML = analysisContent;

        // --- Marker Tooltip 更新 (維持原本邏輯) ---
        if (typeof markerB !== 'undefined' && markerB) {
            markerB.unbindTooltip();
            let tooltipDir = 'right';
            let tooltipOffset = [15, 0];
            const diffLat = pointB.lat - pointA.lat;
            const diffLon = pointB.lon - pointA.lon;

            if (Math.abs(diffLon) > Math.abs(diffLat)) {
                if (diffLon >= 0) { tooltipDir = 'right'; tooltipOffset = [15, 0]; }
                else { tooltipDir = 'left'; tooltipOffset = [-15, 0]; }
            } else {
                if (diffLat >= 0) { tooltipDir = 'top'; tooltipOffset = [0, -15]; }
                else { tooltipDir = 'bottom'; tooltipOffset = [0, 15]; }
            }

            markerB.bindTooltip(`
                <div onmousedown="event.stopPropagation();" onclick="event.stopPropagation();" style="font-size:13px; line-height:1.4;">
                    <b style="color:#28a745;">區間分析 (A ↔ B)</b><br>
                    ${analysisContent}
                    <div style="margin-top:8px; border-top:1px solid #eee; padding-top:4px; text-align:right;">
                        <a href="javascript:void(0);" onclick="event.stopPropagation(); clearABSettings();" style="color:#d35400; text-decoration:none; font-weight:bold; font-size:12px;">❌ 清除 A B 點</a>
                    </div>
                </div>`, { 
                    permanent: true, 
                    interactive: true, 
                    direction: tooltipDir, 
                    offset: tooltipOffset, 
                    className: 'ab-map-tooltip' 
                }).openTooltip();
        }
    } else {
        if (boxRes) boxRes.style.display = "none";
        if (typeof markerB !== 'undefined' && markerB) { markerB.unbindTooltip(); }
    }
    
    if (pointA && pointB && pointA.idx === -1 && pointB.idx === -1) {
        if (typeof analyzeBestPath === 'function') {
            analyzeBestPath(pointA.lat, pointA.lon, pointB.lat, pointB.lon);
        }
    }
}

function renderRouteInfo() {
  if (!allTracks || allTracks.length === 0) {
    return;
  }

  const currentTrackIdx = parseInt(document.getElementById("routeSelect").value || 0);
  const currentRoute = allTracks[currentTrackIdx];
  
  if (!currentRoute) {
    return;
  }

  if (!trackPoints || trackPoints.length === 0) {
    renderEmptyRouteSummary(currentRoute);
    return;
  }

  let f = trackPoints[0], l = trackPoints.at(-1);
  let displayDist = l.distance || 0;
  let displayGain, displayLoss, displayMaxEle, displayMinEle, displayDur;

  if (currentRoute.isCombined) {
    const subTracks = allTracks.filter(t => !t.isCombined);
    const allEles = subTracks.flatMap(t => t.points.map(p => p.ele)).filter(e => e !== undefined);
    
    displayMaxEle = allEles.length > 0 ? Math.max(...allEles) : 0;
    displayMinEle = allEles.length > 0 ? Math.min(...allEles) : 0;

    displayGain = 0;
    displayLoss = 0;
    subTracks.forEach(t => {
      if (t.points && t.points.length > 0) {
        const stats = calculateElevationGainFiltered(t.points);
        displayGain += stats.gain;
        displayLoss += stats.loss;
      }
    });

    displayDist = subTracks.reduce((sum, t) => {
      const lastP = t.points ? t.points.at(-1) : null;
      return sum + (lastP ? (lastP.distance || 0) : 0);
    }, 0);

    displayDur = (l.timeUTC && f.timeUTC) ? (l.timeUTC - f.timeUTC) : 0; 
  } else {
    const { gain, loss } = calculateElevationGainFiltered();
    displayGain = gain;
    displayLoss = loss;
    const trackEles = trackPoints.map(p => p.ele).filter(e => e !== undefined);
    displayMaxEle = trackEles.length > 0 ? Math.max(...trackEles) : 0;
    displayMinEle = trackEles.length > 0 ? Math.min(...trackEles) : 0;
    displayDur = (l.timeUTC && f.timeUTC) ? (l.timeUTC - f.timeUTC) : 0;
  }

  const displayName = window.currentFileNameForDisplay || (allTracks[0] ? allTracks[0].name : "");
  const recordDate = f.timeLocal ? f.timeLocal.substring(0, 10) : "無日期資料";

  // ✅ 核心修正：處理花費時間的顯示邏輯
  let timeString = "";
  // 檢查：1. 必須有時間 2. 時間差必須為正值 3. 時間差不應大到不合理(例如超過10年, 約 3.15e11 ms)
  if (displayDur > 0 && displayDur < 315360000000) {
      const hours = Math.floor(displayDur / 3600000);
      const mins = Math.floor((displayDur % 3600000) / 60000);
      timeString = `${hours} 小時 ${mins} 分鐘`;
  } else {
      // 如果是規劃路線(BaseCamp產出)，通常沒有時間資料，或是時間亂跳
      timeString = "無時間資訊";
  }

  document.getElementById("routeSummary").innerHTML = `
    檔案名稱：${displayName}<br>
    記錄日期：${recordDate}<br>
    路　　線：${currentRoute.name}<br>
    里　　程：${displayDist.toFixed(2)} km<br>
    花費時間：${timeString}<br>
    最高海拔：${displayMaxEle.toFixed(0)} m<br>
    最低海拔：${displayMinEle.toFixed(0)} m<br>
    總爬升數：${displayGain.toFixed(0)} m<br>
    總下降數：${displayLoss.toFixed(0)} m`;

  renderWaypointsAndPeaks(currentRoute);
}

function renderEmptyRouteSummary(currentRoute) {
  // 1. 強制隱藏高度表容器 (使用 !important 確保不會被其他 JS 撐開)
  const chartContainer = document.getElementById("chartContainer");
  if (chartContainer) {
    chartContainer.style.setProperty("display", "none", "important");
  }

  // 2. 徹底銷毀圖表實例，清空所有資訊
  if (window.chart) {
    window.chart.destroy();
    window.chart = null;
  }

  // 3. 更新文字資訊 (維持你原本的內容)
  const displayName = window.currentFileNameForDisplay || (allTracks[0] ? allTracks[0].name : "");
  document.getElementById("routeSummary").innerHTML = `
    檔案名稱：${displayName}<br>
    路　　線：${currentRoute.name}<br>
    里程/海拔：純航點模式，無軌跡資料`;

  // 4. 渲染航點列表
  renderWaypointsAndPeaks(currentRoute);
}

// 輔助函式：渲染航點列表與山岳偵測按鈕
function renderWaypointsAndPeaks(currentRoute) {
  const wptListContainer = document.getElementById("wptList");
  const navShortcuts = document.getElementById("navShortcuts");
  let listHtml = "";
  let shortcutsHtml = "";

 if (currentRoute.waypoints && currentRoute.waypoints.length > 0) {
    // --- 🏷️ 修改這裡：將原本的文字換成眼睛圖示與文字的組合 ---
    const icon = showWptNameAlways ? "visibility_off" : "visibility";
    const text = showWptNameAlways ? "航點名稱" : "航點名稱";
    
    // 1. 加入「顯示/隱藏名稱」的功能按鈕
    shortcutsHtml += `
      <button type="button" class="shortcut-btn" onclick="toggleWptNames()" style="display:inline-flex; align-items:center;">
        <span class="material-icons" style="font-size:18px; margin-right:4px;">${icon}</span>
        <span>${text}</span>
      </button>`;
    
    // 2. 原本的「跳轉到航點列表」錨點按鈕
    shortcutsHtml += `<button type="button" class="shortcut-btn" onclick="document.getElementById('anchorWpt').scrollIntoView({behavior: 'smooth'})">📍 航點列表</button>`;

    // 航點表格標題與內容
    listHtml += `<h4 id="anchorWpt" style="margin: 20px 0 10px 0;">📍 航點列表 (${currentRoute.waypoints.length})</h4>`;
    listHtml += `<table class="wpt-table"><thead><tr><th style="width:10%">#</th><th style="width:40%">日期與時間</th><th style="width:50%">航點名稱</th></tr></thead><tbody>`;
    currentRoute.waypoints.forEach((w, i) => { 
      listHtml += `<tr><td><span class="wpt-link" onclick="focusWaypoint(${w.lat}, ${w.lon}, '${w.name}')">${i + 1}</span></td><td>${w.localTime || ''}</td><td>${w.name}</td></tr>`; 
    });
    listHtml += `</tbody></table>`;
  }

  listHtml += `<h4 id="anchorPeak" style="margin: 30px 0 10px 0; font-size: 16px; color: #2c3e50; border-left: 5px solid #d35400; padding-left: 10px;">⛰️ 沿途山岳(200公尺內)</h4>`;
  listHtml += `
    <div id="aiPeaksSection">
        <div style="padding:15px; text-align:center; background:#f8f9fa; border:1px dashed #ccc; border-radius:8px; margin:10px 0;">
            <p style="margin-bottom:8px; color:#666; font-size:13px;">📍 已準備好偵測此路線周圍山岳</p>
            <button onclick="detectPeaksAlongRoute(true)" style="padding: 10px 25px; background: #1a73e8; color: white; border: none; border-radius: 50px; cursor: pointer; font-weight: bold; font-size: 14px; box-shadow: 0 2px 4px rgba(0,0,0,0.2); display: inline-flex; align-items: center; justify-content: center; vertical-align: middle; outline: none;">🔍 偵測此路線山岳</button>
        </div>
    </div>`;
  
  shortcutsHtml += `<button type="button" class="shortcut-btn" onclick="document.getElementById('anchorPeak').scrollIntoView({behavior: 'smooth'})">⛰️ 沿途山岳</button>`;

  wptListContainer.innerHTML = listHtml;
  wptListContainer.style.display = "block";
  navShortcuts.innerHTML = shortcutsHtml;
}


function formatDate(d) { return d.toISOString().replace("T", " ").substring(0, 19); }

// ================= 自動偵測經過山岳 (Overpass API) =================
let peakAbortController = null; 

/**
 * 偵測經過山岳
 * @param {boolean} isManual - 是否為手動點擊觸發
 */
async function detectPeaksAlongRoute(isManual = false) {
    // 1. 如果有之前的偵測還在跑，直接取消它
    if (typeof peakAbortController !== 'undefined' && peakAbortController) {
        peakAbortController.abort();
    }
    
    const wptListContainer = document.getElementById("wptList");
    if (!wptListContainer) return;
    wptListContainer.style.display = "block";

    let aiSection = document.getElementById("aiPeaksSection");
    if (!aiSection) {
        aiSection = document.createElement("div");
        aiSection.id = "aiPeaksSection";
        wptListContainer.appendChild(aiSection);
    }

    if (!isManual) {
        aiSection.innerHTML = `
            <div style="padding:20px; text-align:center; background:#f9f9f9; border:1px dashed #ccc; border-radius:8px; margin:10px 0;">
                <p style="margin-bottom:10px; color:#666; font-size:14px;">📍 路線已載入：準備好偵測此範圍內之山岳</p>
				<button onclick="detectPeaksAlongRoute(true)" 
        style="padding: 10px 25px; /* 橢圓形通常兩側留白更多，外觀更協調 */
               background: #1a73e8; 
               color: white; 
               border: none; 
               
               /* 關鍵修改：將 border-radius 設定為 50px，強制橢圓形 */
               border-radius: 50px; 
               
               cursor: pointer; 
               font-weight: bold; 
               font-size: 14px; 
               box-shadow: 0 2px 4px rgba(0,0,0,0.2);
               
               /* 確保按鈕內容垂直置中 */
               display: inline-flex;
               align-items: center;
               justify-content: center;
               vertical-align: middle;
               outline: none;
               -webkit-tap-highlight-color: transparent;">
   						 🔍 開始偵測沿途山岳
				</button>
            </div>`;
        return; // 結束，不往下執行偵測
    }
    
    peakAbortController = new AbortController();
    
    // 初始化 UI 為載入中
    aiSection.innerHTML = `<div id="aiLoading" style="padding:20px; text-align:center; color:#666;">
        <div class="spinner" style="margin-bottom:10px;">🔄</div>
        🔍 正在掃描全線資料，偵測 200 公尺內山岳...
    </div>`;

    if (typeof trackPoints === 'undefined' || !trackPoints || trackPoints.length === 0) {
        aiSection.innerHTML = `<div style="padding:10px; color:red;">無法取得軌跡點資料。</div>`;
        return;
    }

    const maxSamples = 80; 
    const samplingRate = Math.max(1, Math.floor(trackPoints.length / maxSamples));
    const sampledPoints = trackPoints.filter((_, i) => i % samplingRate === 0);
    
    let aroundSegments = sampledPoints.map(p => `node(around:200,${p.lat},${p.lon})[natural=peak];`).join("");
    const fullQuery = `[out:json][timeout:30];(${aroundSegments});out body;`;

    const timeoutId = setTimeout(() => {
        if (peakAbortController) peakAbortController.abort();
    }, 25000); // 結合路線較長，逾時時間稍拉長

    try {
        const response = await fetch("https://overpass-api.de/api/interpreter", { 
            method: "POST", 
            body: "data=" + encodeURIComponent(fullQuery),
            signal: peakAbortController.signal 
        });
        clearTimeout(timeoutId);

        const data = await response.json();
        
        if (!data.elements || data.elements.length === 0) {
            aiSection.innerHTML = `<div style="padding:20px; color:#999; font-size:13px; text-align:center;">ℹ️ 沿途 200m 內未偵測到額外的山峰標記。</div>`;
            return;
        }

        const uniquePeaks = [];
        const seenNames = new Set();
        
        data.elements.forEach(el => {
            const name = el.tags.name || "未命名山峰";
            const ele = el.tags.ele || "未知";
            
            if (!seenNames.has(name)) {
                seenNames.add(name);
                
                let minMeterDist = Infinity, bestIdx = 0;
                trackPoints.forEach((tp, i) => {
                    const R = 6371000;
                    const dLat = (el.lat - tp.lat) * Math.PI / 180;
                    const dLon = (el.lon - tp.lon) * Math.PI / 180;
                    const a = Math.sin(dLat/2) ** 2 + Math.cos(tp.lat * Math.PI / 180) * Math.cos(el.lat * Math.PI / 180) * Math.sin(dLon/2) ** 2;
                    const d = 2 * R * Math.asin(Math.sqrt(a));
                    if (d < minMeterDist) { minMeterDist = d; bestIdx = i; }
                });

                uniquePeaks.push({ 
                    name, 
                    ele, 
                    lat: el.lat, 
                    lon: el.lon, 
                    time: trackPoints[bestIdx].timeLocal, 
                    idx: bestIdx, 
                    distToTrack: minMeterDist 
                });
            }
        });

        uniquePeaks.sort((a, b) => a.idx - b.idx);
        
        if (typeof renderPeakTable === 'function') {
            renderPeakTable(uniquePeaks);
        }

    } catch (error) {
        if (error.name === 'AbortError') {
          } else {
            aiSection.innerHTML = `
                <div style="padding:20px; color:#721c24; background-color:#f8d7da; border:1px solid #f5c6cb; border-radius:8px; text-align:center; margin:10px 0;">
                    <p style="margin-bottom:10px;">❌ 山岳偵測失敗 (API 忙碌中或網路逾時)</p>
									<button onclick="detectPeaksAlongRoute(true)" 
					        style="padding: 8px 20px; 
					               background: #d35400; 
					               color: white; 
					               border: none; 
					               border-radius: 50px; 
					               cursor: pointer; 
					               font-weight: bold;
					               box-shadow: 0 2px 4px rgba(0,0,0,0.15);
					               outline: none;">
					  					  🔄 重新嘗試
							  	</button>
                </div>`;
        }
    }
}

let autoRouteLayer = null;

async function analyzeBestPath(latA, lonA, latB, lonB) {
    // 1. 定義搜尋範圍 (取 A, B 的矩形區域並稍微擴大)
    const minLat = Math.min(latA, latB) - 0.01;
    const maxLat = Math.max(latA, latB) + 0.01;
    const minLon = Math.min(lonA, lonB) - 0.01;
    const maxLon = Math.max(lonA, lonB) + 0.01;

    const query = `
        [out:json][timeout:25];
        (
          way["highway"~"path|footway|track"](${minLat},${minLon},${maxLat},${maxLon});
        );
        out body; >; out skel qt;
    `;

    const url = "https://overpass-api.de/api/interpreter?data=" + encodeURIComponent(query);
    
    try {
        const response = await fetch(url);
        const data = await response.json();
        
        if (autoRouteLayer) map.removeLayer(autoRouteLayer);

        autoRouteLayer = L.geoJSON(osmtogeojson(data), {
            style: {
                color: "#FF5722",
                weight: 4,
                opacity: 0.7,
                dashArray: "5, 10" // 虛線表示這是系統建議路徑
            }
        }).addTo(map);


    } catch (error) {
        console.error("OSM 資料請求失敗:", error);
    }
}

function renderPeakTable(peaks) {
    const aiSection = document.getElementById("aiPeaksSection");
    if (!aiSection || peaks.length === 0) return;
		let html = `<table class="wpt-table"><thead><tr><th style="width:10%">#</th><th style="width:40%">日期與時間</th><th style="width:50%">山名 (海拔)</th></tr></thead><tbody>`;
    peaks.forEach((p, i) => {
        const timeDisplay = p.distToTrack > 100 ? "------" : p.time;
        html += `<tr><td><span class="wpt-link" onclick="focusWaypoint(${p.lat}, ${p.lon}, '${p.name}', ${p.distToTrack}, '${p.ele}')">${i+1}</span></td><td>${timeDisplay}</td><td style="font-weight: bold; color: #007bff;">${p.name} (${p.ele}m)</td></tr>`;
    });
    aiSection.innerHTML = html + `</tbody></table>`;
}

let gUrl = "#";
// 執行地圖移動與標記顯示
window.jumpToLocation = function(lat, lon) {
    const twd97 = proj4(WGS84_DEF, TWD97_DEF, [lon, lat]);
    const twd67 = proj4(WGS84_DEF, TWD67_DEF, [lon, lat]);
    
    const gUrl = `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
    
    // 使用您指定的圖片位址，並加上按鈕化的 CSS
    const gMapIconBtn = `
        <a href="${gUrl}" target="_blank" 
           style="text-decoration:none; margin-right:8px; display:inline-flex; align-items:center; justify-content:center; width: 28px; height: 28px; background: #fff; border: 1px solid #ccc; border-radius: 50%; box-shadow: 0 2px 4px rgba(0,0,0,0.15); vertical-align: middle;">
            <img src="https://ychiking.github.io/gpx-online-viewer/GoogleMaps.png" style="width:18px; height:18px;" alt="GMap">
        </a>`;

    const content = `
        <div style="font-size:14px; line-height:1.5; min-width:180px;">
            <div style="display:flex; align-items:center;">
                ${gMapIconBtn}
                <b style="color:#1a73e8; font-size:15px;">定位點資訊</b>
            </div>
            <hr style="margin:5px 0; border:0; border-top:1px solid #eee;">
            <div style="padding:5px 0;">
                WGS84: ${lat.toFixed(6)}, ${lon.toFixed(6)}<br>
                TWD97: ${Math.round(twd97[0])}, ${Math.round(twd97[1])}<br>
                TWD67: ${Math.round(twd67[0])}, ${Math.round(twd67[1])}
            </div>
            <div style="display:flex; margin-top:10px; gap:5px;">
                <button onclick="setFreeAB('A', ${lat}, ${lon})" style="flex:1; background:#007bff; color:white; border:none; padding:6px; border-radius:4px; cursor:pointer; font-weight:bold;">設定 A</button>
                <button onclick="setFreeAB('B', ${lat}, ${lon})" style="flex:1; background:#e83e8c; color:white; border:none; padding:6px; border-radius:4px; cursor:pointer; font-weight:bold;">設定 B</button>
            </div>
        </div>
    `;

    document.getElementById('coordModal').style.display = 'none';
    map.setView([lat, lon], 16); 
    
    const jumpMarker = L.marker([lat, lon]).addTo(map);
    if (jumpMarker._icon) {
        jumpMarker._icon.style.filter = "hue-rotate(180deg) brightness(160%)";
    }

    jumpMarker.bindPopup(content).openPopup();

    map.once('click', () => {
        if (map.hasLayer(jumpMarker)) map.removeLayer(jumpMarker);
    });
};

window.executeJump = function(type) {
    if (typeof event !== 'undefined') event.stopPropagation();

    let lat, lng;

    if (type === 'WGS') {
        const wgsType = document.getElementById('wgs_type').value;
        if (wgsType === 'DD') {
            lat = parseFloat(document.getElementById('lat_dd').value);
            lng = parseFloat(document.getElementById('lng_dd').value);
        } else {
            const ld = parseFloat(document.getElementById('lat_d').value) || 0;
            const lm = parseFloat(document.getElementById('lat_m').value) || 0;
            const ls = parseFloat(document.getElementById('lat_s').value) || 0;
            lat = ld + (lm / 60) + (ls / 3600);

            const nd = parseFloat(document.getElementById('lng_d').value) || 0;
            const nm = parseFloat(document.getElementById('lng_m').value) || 0;
            const ns = parseFloat(document.getElementById('lng_s').value) || 0;
            lng = nd + (nm / 60) + (ns / 3600);
        }
        
        if (isNaN(lat) || isNaN(lng) || lat === 0) {
            showMapToast("請填寫緯經度");
            return;
        }
        window.jumpToLocation(lat, lng);

    } else {
        const twdSystem = document.getElementById('twd_system').value;
        const sourceDef = (twdSystem === '67') ? TWD67_DEF : TWD97_DEF;
        const xStr = document.getElementById('twd_x').value;
        const yStr = document.getElementById('twd_y').value;

        let x = parseFloat(xStr);
        let y = parseFloat(yStr);

        if (xStr.length === 4) x = x * 100;
        if (yStr.length === 5) y = y * 100;

        if (isNaN(x) || isNaN(y)) {
            showMapToast("請填寫 X 與 Y");
            return;
        }

        const coord = proj4(sourceDef, WGS84_DEF, [x, y]);
        window.jumpToLocation(coord[1], coord[0]);
    }
    
    window.scrollTo({ top: 0, behavior: 'smooth' });
};

function showMapToast(message) {
    let toast = document.getElementById('map-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'map-toast';
        toast.style.cssText = `
            position: fixed;
            top: 20px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(0, 0, 0, 0.8);
            color: white;
            padding: 10px 20px;
            border-radius: 20px;
            z-index: 10000;
            font-size: 14px;
            pointer-events: none;
            transition: opacity 0.5s;
        `;
        document.body.appendChild(toast);
    }
    toast.innerText = message;
    toast.style.opacity = '1';
    
    // 3秒後隱藏
    setTimeout(() => {
        toast.style.opacity = '0';
    }, 3000);
}

// ================= 多檔案匯入專用邏輯 =================
let multiGpxStack = []; 
const multiColors = ['#FF0000', '#0000FF', '#FFA500', '#800080', '#FFD700', '#A52A2A', '#7FFF00', '#87CEFA', '#006400', '#FFC0CB'];

document.getElementById("multiGpxInput").addEventListener("change", async (e) => {
    clearEverything(); 
    if (typeof window.resetGPS === 'function') window.resetGPS();
    if (typeof polyline !== 'undefined' && polyline) map.removeLayer(polyline);

    const files = e.target.files;
    if (!files || files.length === 0) return;
    
    // 關鍵 1：重置全域 allTracks，確保多檔模式下的索引與 multiGpxStack 一致
    allTracks = []; 
    
    document.getElementById("fileNameDisplay").innerHTML = `
        <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
            <span>已匯入 ${files.length} 個 GPX 檔案</span>
            <button type="button" class="shortcut-btn close-circle-btn" onclick="location.reload()">✕</button>
        </div>
    `;
    clearAllMultiGPX(); 
    
    const hint = document.getElementById('importHint');
    if (hint) hint.style.display = 'none';
    
    let allBounds = L.latLngBounds([]);

    for (let i = 0; i < files.length; i++) {
        const text = await files[i].text();
        const pureFileName = files[i].name.replace(/\.[^/.]+$/, "");
        const tracks = processGpxXml(text); 
        
        let combinedPoints = [];
        let combinedWaypoints = [];
        tracks.forEach(t => {
            combinedPoints = combinedPoints.concat(t.points || []);
            combinedWaypoints = combinedWaypoints.concat(t.waypoints || []);
        });

        if (combinedPoints.length === 0 && combinedWaypoints.length === 0) continue;

        // 關鍵 2：預先建立完整的資料結構
        const gpxData = {
            name: files[i].name,
            fileName: pureFileName,
            points: combinedPoints,
            waypoints: combinedWaypoints,
            distance: 0,
            elevationGain: 0,
            elevationLoss: 0,
            duration: "00:00:00",
            avgSpeed: 0,
            maxElevation: 0,
            minElevation: 0
        };

        // 同步到全域陣列，供 loadRoute 使用
        allTracks.push(gpxData);

        const color = multiColors[i % multiColors.length];
        const gpxId = "gpx_" + Date.now() + "_" + i; 

        let layer;
        let currentBounds = L.latLngBounds([]);

        if (combinedPoints.length > 0) {
            // 修正：在地圖線條建立時，直接把當前的索引 i 綁進去，確保 click 時抓到正確的 index
            layer = L.polyline(combinedPoints.map(p => [p.lat, p.lon]), {
                color: color, 
                weight: 4, 
                opacity: 0.8, 
                gpxId: gpxId,
                trackIndex: allTracks.length - 1 // 儲存它在陣列中的位置
            }).addTo(map);

            layer.on('click', (e) => {
                L.DomEvent.stopPropagation(e); 
                // 恢復地圖點擊切換的核心：直接呼叫 switchMultiGpx 並傳入正確的索引
                const targetIdx = e.target.options.trackIndex;
                if (typeof switchMultiGpx === 'function') {
                    switchMultiGpx(targetIdx);
                }
            });
            currentBounds = layer.getBounds();
        } else {
            layer = L.featureGroup().addTo(map);
            layer.options = { gpxId: gpxId, trackIndex: allTracks.length - 1 }; 
            if (combinedWaypoints.length > 0) {
                const coords = combinedWaypoints.map(w => [w.lat, w.lon]);
                currentBounds = L.latLngBounds(coords);
            }
        }

        multiGpxStack.push({
            id: gpxId, 
            name: files[i].name,
            fileName: pureFileName,
            content: text,          
            points: combinedPoints,
            waypoints: combinedWaypoints,
            layer: layer,
            color: color
        });

        if (currentBounds && currentBounds.isValid()) allBounds.extend(currentBounds);
    }

    if (multiGpxStack.length > 0) {
        document.getElementById('multiGpxBtnBar').style.display = 'flex';
        renderMultiGpxButtons();
        
        if (multiGpxStack.length > 0) {
   		switchMultiGpx(0);}
        
        const firstItem = multiGpxStack[0];
        let firstBounds;
        if (firstItem.points.length > 0) {
            firstBounds = firstItem.layer.getBounds();
        } else if (firstItem.waypoints.length > 0) {
            firstBounds = L.latLngBounds(firstItem.waypoints.map(w => [w.lat, w.lon]));
        }

        if (firstBounds && firstBounds.isValid()) {
            map.fitBounds(firstBounds, { padding: [20, 20], maxZoom: 16 });
        }
        
        // 關鍵 3：延遲並確保 currentMultiIndex 正確
        setTimeout(() => {
             try {
                window.currentMultiIndex = 0;
                if (typeof loadRoute === 'function') {
                    loadRoute(0);
                }
            } catch (err) {
                console.error(">>> [LOG] 最終渲染失敗:", err);
            }
        }, 300);
    }
    e.target.value = ""; 
});

function switchMultiGpx(index) {
    const data = multiGpxStack[index];
    if (!data) return;
    
    window.currentMultiIndex = index;
    map.closePopup();
    
    window.currentFileNameForDisplay = data.name;

    // 1. 處理所有圖層的「原始顏色」與「半透明」狀態
    multiGpxStack.forEach((item, i) => {
        const btn = document.getElementById(`multi-btn-${i}`);
        if (i === index) {

            item.layer.setStyle({ 
                color: item.color, // 保持原始顏色
                weight: 8,         // 加粗
                opacity: 1.0       // 全顯
            }).bringToFront(); 
            
            if (btn) btn.classList.add('active');
            
            btn.scrollIntoView({
                    behavior: 'smooth', // 平滑捲動
                    block: 'nearest',   // 垂直方向捲到最近
                    inline: 'center'    // 水平方向捲到中間 (最適合 GPX Bar)
                });
            
            
            // map.fitBounds(item.layer.getBounds(), { padding: [20, 20], maxZoom: 16 });
            if (!isGpxInView(index)) {
        map.fitBounds(item.layer.getBounds(), { padding: [20, 20], maxZoom: 16 });
    }
        } else {
            // --- 未選中的檔案 ---
            item.layer.setStyle({ 
                color: item.color, // 保持原始顏色
                weight: 5, 
                opacity: 0.5       // 變淡作為背景
            });
            if (btn) btn.classList.remove('active');
        }
    });

    if (data.content) {
        const pureFileName = data.name.replace(/\.[^/.]+$/, "");
        parseGPX(data.content, pureFileName);
        
        setTimeout(() => {
            if (window.activeRouteLayer) {
                activeRouteLayer.setStyle({ color: data.color });
            }
        }, 50); 
        
    } else {
        allTracks = [{ name: data.name, points: data.points, waypoints: data.waypoints }];
        trackPoints = data.points; 
        loadRoute(0); 
        if (window.activeRouteLayer) {
            activeRouteLayer.setStyle({ color: data.color });
        }
    }

    const toggleBtn = document.getElementById("toggleChartBtn");
    if (toggleBtn) {
        toggleBtn.style.display = "block"; 
        toggleBtn.textContent = "收合高度表"; 
    }
    document.getElementById("chartContainer").style.display = "block";
    document.getElementById("wptList").style.display = "block";
    
    if (typeof detectPeaksAlongRoute === 'function') {
        if (typeof peakAbortController !== 'undefined' && peakAbortController) {
            peakAbortController.abort();
        }
        detectPeaksAlongRoute(false); 
    }
    
    if (typeof hoverMarker !== 'undefined' && hoverMarker) { hoverMarker.bringToFront(); }
}

function renderMultiGpxButtons() {
    const bar = document.getElementById('multiGpxBtnBar');
    if (!bar) return;

		if (multiGpxStack && multiGpxStack.length > 0) {
        document.body.classList.add('has-gpx-bar');
    } else {
        document.body.classList.remove('has-gpx-bar');
    }

    bar.innerHTML = ''; // 先清空
    
    const closeBtn = document.createElement('button');
    closeBtn.className = 'gpx-file-btn close-btn';
    closeBtn.innerHTML = '✕ 關閉檔案';
    closeBtn.onclick = (e) => {
        if (e) L.DomEvent.stopPropagation(e); 
        clearAllMultiGPX();
        location.reload();
    };
    bar.appendChild(closeBtn);
    
    multiGpxStack.forEach((gpx, i) => {
        const btn = document.createElement('button');
        btn.className = 'gpx-file-btn';
        btn.id = `multi-btn-${i}`;
        
        const maxLength = 40;
        btn.textContent = gpx.name.length > maxLength 
            ? gpx.name.substring(0, maxLength) + "..." 
            : gpx.name;

        btn.setAttribute('title', gpx.name); 
        btn.style.borderLeft = `5px solid ${gpx.color}`;
        
        btn.onclick = (e) => {
            if (e) L.DomEvent.stopPropagation(e);
            switchMultiGpx(i);
        };
        
        bar.appendChild(btn);
    });

    L.DomEvent.disableClickPropagation(bar);
    L.DomEvent.disableScrollPropagation(bar);

    const stopMe = (e) => e.stopPropagation();
    bar.addEventListener('touchstart', stopMe, { passive: true });
    bar.addEventListener('touchmove', stopMe, { passive: true });
    bar.addEventListener('pointerdown', stopMe, { passive: true });
}

function clearAllMultiGPX() {

    multiGpxStack.forEach(item => map.removeLayer(item.layer));
    
    markers.forEach(m => map.removeLayer(m));
    markers = [];
    wptMarkers.forEach(m => map.removeLayer(m));
    wptMarkers = [];
    
    // 清除高度圖
    if (chart) chart.destroy();
    
    multiGpxStack = [];
    const bar = document.getElementById('multiGpxBtnBar');
    if (bar) {
        bar.style.display = 'none';
        bar.innerHTML = '';
    }
    
    document.getElementById("routeSummary").textContent = "尚未讀取資料";
    document.getElementById("chartContainer").style.display = "none";
    document.getElementById("wptList").style.display = "none";
}

window.switchToTrack = function(id) {
    const target = allTracks.find(t => t.id === id);
    if (!target) return;
    currentFocusId = id;

    // 1. 執行解析 (這會更新全域的 trackPoints)
    parseGPX(target.content);

    // 2. 【核心修正】點擊後立刻檢查：如果是純航點，強制關閉/隱藏高度表
    // 假設你的高度表容器 ID 是 chartContainer
    const chartBtn = document.getElementById('chartContainer'); 
    
    if (!window.trackPoints || window.trackPoints.length === 0) {
        
        // 強制隱藏容器
        if (chartBtn) {
            chartBtn.style.setProperty("display", "none", "important");
        }
        
        // 銷毀舊圖表防止殘留
        if (window.chart) {
            window.chart.destroy();
            window.chart = null;
        }

        // 如果你有一個全域變數控制「面板是否開啟」，要在這裡設為 false
        // window.isElevationChartVisible = false;

    } else {
        // 如果有軌跡，才允許執行原本的顯示邏輯
        if (chartBtn) {
            chartBtn.style.display = 'block';
        }
        if (typeof drawElevationChart === 'function') {
            drawElevationChart();
        }
    }

    // ... 後續的背景軌跡渲染與 UI 更新 ...
    renderRouteInfo();
    renderTrackButtons();
};

function toggleElevationChart() {
    const chartContainer = document.getElementById("chartContainer");
    const btn = document.getElementById("toggleChartBtn");
    const tipLabel = document.getElementById("chartTipToggleLabel"); // 取得 Checkbox 容器

    if (chartContainer.style.display === "none" || chartContainer.style.display === "") {
        // --- 執行展開 ---
        chartContainer.style.display = "block";
        btn.textContent = "收合高度表";
        
        // 修正：展開時，如果目前有軌跡資料，就顯示 Checkbox
        if (tipLabel && trackPoints && trackPoints.length > 0) {
            tipLabel.style.display = "flex";
        }
        
        if (window.chart) {
            window.chart.resize();
        }
    } else {
        // --- 執行收合 ---
        chartContainer.style.display = "none";
        btn.textContent = "展開高度表";
        
        // 修正：收合時，強制隱藏 Checkbox
        if (tipLabel) {
            tipLabel.style.display = "none";
        }
        
        // 收合時同步關閉地圖上的彈窗，避免殘留
        if (currentPopup) map.closePopup();
    }
}

const gMapIconBtn = `
    <a href="${gUrl}" target="_blank" title="於 Google Map 開啟" 
       style="text-decoration:none; 
              margin-right:8px; 
              display:inline-flex; 
              align-items:center; 
              justify-content:center;
              width: 28px; 
              height: 28px; 
              background: #ffffff; 
              border: 1px solid #ddd; 
              border-radius: 50%; 
              box-shadow: 0 2px 4px rgba(0,0,0,0.2); 
              transition: all 0.2s ease;
              vertical-align: middle;">
        <img src="https://ychiking.github.io/gpx-online-viewer/GoogleMaps.png" 
             style="width:18px; height:18px; display:block;" 
             alt="Google Maps">
    </a>`;
    
function isGpxInView(gpxData) {
    let pointsForBounds = [];

    // 1. 收集軌跡點
    if (gpxData.trackPoints && gpxData.trackPoints.length > 0) {
        pointsForBounds = pointsForBounds.concat(gpxData.trackPoints);
    }

    // 2. 收集航點 (純航點模式關鍵)
    if (gpxData.waypoints && gpxData.waypoints.length > 0) {
        pointsForBounds = pointsForBounds.concat(gpxData.waypoints);
    }

    // 3. 安全檢查：如果完全沒有點，就直接回傳 true (或 false)，避免建立空的 bounds
    if (pointsForBounds.length === 0) return true;

    // 4. 建立範圍並判斷
    try {
        const bounds = L.latLngBounds(pointsForBounds.map(p => [p.lat, p.lon]));
        return map.getBounds().intersects(bounds);
    } catch (e) {
        console.error(">>> [Error] 判斷視角範圍失敗:", e);
        return true; 
    }
}

window.addEventListener('DOMContentLoaded', (event) => {
    setupProgressBar(); // 啟動時先綁定好「拉動」的動作
});