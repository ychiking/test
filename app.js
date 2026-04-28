// ================= 地圖初始化 =================
const map = L.map("map", { tap: true }).setView([25.03, 121.56], 12);
const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap" }).addTo(map);
const otm = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", { maxZoom: 18, maxNativeZoom: 17, attribution: 'OpenTopoMap' });
// Happyman（當底圖）
const happyman = L.tileLayer(
  "https://tile.happyman.idv.tw/map/happyman/{z}/{x}/{y}.png",
  {
    maxZoom: 18,
    attribution: "Happyman Map"
  }
);

// 魯地圖（疊圖）
const rudy = L.tileLayer(
  "https://tile.happyman.idv.tw/map/moi_osm/{z}/{x}/{y}.png",
  {
    maxZoom: 18,
    attribution: "Rudy Map",
    opacity: 0.5   // 👈 疊圖透明度
  }
);

// 魯地圖（疊圖）
const rudyM = L.tileLayer(
  "https://tile.happyman.idv.tw/map/moi_osm/{z}/{x}/{y}.png",
  {
    maxZoom: 18,
    attribution: "Rudy Map",
    opacity: 0.5   // 👈 疊圖透明度
  }
);

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
    "魯地圖 (等高線)": rudyM,    
    "等高線地形圖 (OpenTopo)": otm,
    "內政部臺灣通用電子地圖": emap 
};

const overlayMaps = {
	  "魯地圖疊圖": rudy,
		"Happyman疊圖": happyman, 
    "WGS84 格線": gridLayers.WGS84,
    "TWD97 格線": gridLayers.TWD97,
    "TWD67 格線": gridLayers.TWD67,
    "顯示百米細格": gridLayers.SubGrid  // 新增：獨立的 Checkbox
};

L.control.layers(baseMaps, overlayMaps).addTo(map);

//happyman.addTo(map);
rudy.addTo(map);
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
    
    // 1. 取得所有原始航點 (wpt)
    const wpts = xml.getElementsByTagName("wpt");
    let allWpts = [];
    for (let w of wpts) {
        const lat = parseFloat(w.getAttribute("lat")), lon = parseFloat(w.getAttribute("lon"));
        const name = w.getElementsByTagName("name")[0]?.textContent || "未命名航點";
        const timeNode = w.getElementsByTagName("time")[0];
        const rawTime = timeNode ? timeNode.textContent.trim() : null;
        const ele = w.getElementsByTagName("ele")[0]?.textContent;
        
        allWpts.push({ 
            lat, lon, name, 
            ele: ele ? parseFloat(ele) : 0,
            time: rawTime,
            localTime: rawTime ? formatDate(new Date(new Date(rawTime).getTime() + 8*3600000)) : "無時間資訊" 
        });
    }

    // 2. 處理每一條路線 (trk)
    const trks = xml.getElementsByTagName("trk");
    
    if (trks.length > 0) {
        for (let i = 0; i < trks.length; i++) {
            const pts = trks[i].getElementsByTagName("trkpt");
            const points = extractPoints(pts);
            
            // ✅ 修正：不再 filter，直接讓每條路線都能存取所有航點
            // 距離與時間的過濾，留到 loadRoute 執行時再動態判斷即可
            if (points.length > 0) {
                tempTracks.push({ 
                    name: trks[i].getElementsByTagName("name")[0]?.textContent || `路線 ${i + 1}`, 
                    points, 
                    waypoints: allWpts 
                });
            }
        }
    }

    // 3. 處理純航點情況 (或者有軌跡但軌跡沒點的情況)
    if (tempTracks.length === 0 && allWpts.length > 0) {
        tempTracks.push({
            name: "航點資料",
            points: [],
            waypoints: allWpts
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

// fullScreenBtn.addTo(map);

// 專門處理「非路徑點」的彈窗
function showFreeClickPopup(latlng, searchTitle = null, searchAddr = null) {
    const lat = latlng.lat;
    const lon = latlng.lng;
    const title = searchTitle || "自選位置";

    // --- 🚀 新增：搜尋自動導流邏輯 ---
    // 只有在有標題的情況下才執行，避免一般的地圖點擊誤觸
    if (searchTitle && !["軌跡點", "位置資訊", "自選位置"].includes(title)) {
        let potentialSources = [];
        if (window.allTracks) potentialSources = [...window.allTracks];
        if (window.multiGpxStack) potentialSources = [...potentialSources, ...window.multiGpxStack];

        for (let gpx of potentialSources) {
            if (!gpx || !gpx.waypoints) continue;

             let foundIdx = gpx.waypoints.findIndex(w => {
                const isSameName = (w.name === title || w.name === title.trim());
                const isNearby = Math.abs(w.lat - lat) < 0.0008 && Math.abs(w.lon - lon) < 0.0008;
                return isSameName && isNearby;
            });

            if (foundIdx !== -1) {
                console.log(`[Redirect] 偵測到既有航點 "${title}"，導流至 showCustomPopup`);
                
                // 嘗試找出軌跡上的對應索引 (為了里程計算)
                let trackIdx = 999999;
                if (typeof trackPoints !== 'undefined') {
                    const tIdx = trackPoints.findIndex(tp => 
                        Math.abs(tp.lat - gpx.waypoints[foundIdx].lat) < 0.00015 && 
                        Math.abs(tp.lon - gpx.waypoints[foundIdx].lon) < 0.00015
                    );
                    if (tIdx !== -1) trackIdx = tIdx;
                }

                // 💡 跳轉：帶入正確的 idx、標題、模式、與座標
                // 這會讓彈窗顯示 edit (筆) 並包含所有軌跡資訊
                showCustomPopup(trackIdx, gpx.waypoints[foundIdx].name, "wpt", lat, lon);
                return; // 結束本函式，不執行後面的內容
            }
        }
    }
    // --- 導流結束 ---

    // 1. 高度偵測與軌跡點比對邏輯 (保留原樣)
    let foundEle = null;
    let minDistance = 0.0002; 

    if (typeof trackPoints !== 'undefined' && trackPoints.length > 0) {
        trackPoints.forEach((tp, i) => {
            const d = Math.sqrt(Math.pow(tp.lat - lat, 2) + Math.pow(tp.lon - lon, 2));
            if (d < minDistance) {
                minDistance = d;
                foundEle = tp.ele;    
            }
        });
    }

    const twd97 = proj4(WGS84_DEF, TWD97_DEF, [lon, lat]);
    const twd67 = proj4(WGS84_DEF, TWD67_DEF, [lon, lat]);
    
    // 2. 標題與地址顯示邏輯 (保留原樣)
    const addressHtml = searchAddr ? 
        `<div style="color: #666; font-size: 12px; line-height: 1.4; margin-bottom: 5px; word-break: break-all;">${searchAddr}</div>` : "";
    
    const eleParam = foundEle !== null ? foundEle : 'null';
    const eleDisplay = foundEle !== null ? `高度: ${foundEle.toFixed(0)} m<br>` : "";
    
    // 3. 改用 add_location 圖示 (保留原樣)
    const editIcon = `<span class="material-icons" style="font-size:16px; cursor:pointer; vertical-align:middle; margin-left:4px; color:#d35400;" 
        onclick="event.stopPropagation(); handleWptEdit(-1, ${lat}, ${lon}, ${eleParam}, '${title}', null, null)">add_location</span>`;

    const gUrl = `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
    const gMapIconBtn = `<a href="${gUrl}" target="_blank" style="text-decoration:none; margin-right:8px; display:inline-flex; align-items:center; justify-content:center; width: 28px; height: 28px; background: #fff; border: 1px solid #ccc; border-radius: 50%; box-shadow: 0 2px 4px rgba(0,0,0,0.2); vertical-align: middle;"><img src="https://ychiking.github.io/gpx-online-viewer/GoogleMaps.png" style="width:18px; height:18px; display:block;"></a>`;

    // 4. 介面排版 (保留原樣)
    const content = `
        <div style="min-width:180px; font-size:13px; line-height:1.6;">
            <div style="display:flex; align-items:center; margin-bottom:5px;">
                ${gMapIconBtn}
                <b style="font-size:14px; color:#d35400;">${title}</b>${editIcon}
            </div>
            ${addressHtml}
            <hr style="margin:5px 0; border:0; border-top:1px solid #eee;">
            ${eleDisplay}
            <b>WGS84:</b> ${lat.toFixed(6)}, ${lon.toFixed(6)}<br>
            <b>TWD97:</b> ${Math.round(twd97[0])}, ${Math.round(twd97[1])}<br>
            <b>TWD67:</b> ${Math.round(twd67[0])}, ${Math.round(twd67[1])}
            <div style="display:flex; margin-top:10px; gap:8px;">
                <button onclick="setFreeAB('A', ${lat}, ${lon})" style="flex:1; background:#007bff; color:white; border:none; padding:6px; border-radius:4px; cursor:pointer; font-weight:bold;">設定 A</button>
                <button onclick="setFreeAB('B', ${lat}, ${lon})" style="flex:1; background:#e83e8c; color:white; border:none; padding:6px; border-radius:4px; cursor:pointer; font-weight:bold;">設定 B</button>
            </div>
        </div>`;
    
    if (currentPopup && map.hasLayer(currentPopup)) {
        currentPopup.setLatLng(latlng).setContent(content);
    } else {
        currentPopup = L.popup({ autoClose: false, closeOnClick: false })
            .setLatLng(latlng)
            .setContent(content)
            .openOn(map);
    }
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
  
  const displayName = fileName ? fileName.replace(/\.[^/.]+$/, "") : "結合路線";

  // 1. 取得所有原始航點 (wpt) - 全數保留
  const wpts = xml.getElementsByTagName("wpt");
  let allWpts = [];
  for (let w of wpts) {
    const lat = parseFloat(w.getAttribute("lat")), lon = parseFloat(w.getAttribute("lon"));
    const name = w.getElementsByTagName("name")[0]?.textContent || "未命名航點";
    const time = w.getElementsByTagName("time")[0]?.textContent;
    const ele = w.getElementsByTagName("ele")[0]?.textContent;
    allWpts.push({ 
      lat, lon, name, 
      ele: ele ? parseFloat(ele) : 0,
      time: time || null, // 保留原始 ISO 時間供後續比對
      localTime: time ? formatDate(new Date(new Date(time).getTime() + 8*3600000)) : "無時間資訊" 
    });
  }

  // 2. 處理每一條路線 (trk)
  const trks = xml.getElementsByTagName("trk");
  let combinedPoints = [];
  let combinedWaypoints = allWpts; // 結合路線直接擁有所有航點

  for (let i = 0; i < trks.length; i++) {
    const pts = trks[i].getElementsByTagName("trkpt");
    const points = extractPoints(pts);
    
    if (points.length > 0) {
      const trackData = { 
        name: trks[i].getElementsByTagName("name")[0]?.textContent || `路線 ${i + 1}`, 
        points, 
        waypoints: allWpts // 🔑 關鍵：每一段路線都先持有「全部」航點，顯示與否交給下一關
      };

      allTracks.push(trackData);
      combinedPoints = combinedPoints.concat(points);
    }
  }

  // 如果沒有軌跡但有航點
  if (allTracks.length === 0 && allWpts.length > 0) {
    allTracks.push({ name: displayName || "僅含航點資料", points: [], waypoints: allWpts });
  }

  // 處理結合選項
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
      name: displayName,
      points: reCalibratedPoints,
      waypoints: combinedWaypoints,
      isCombined: true
    });
  }

  const container = document.getElementById("routeSelectContainer");
  if (allTracks.length > 1) {
    routeSelect.innerHTML = "";
    allTracks.forEach((t, i) => {
        const opt = document.createElement("option"); 
        opt.value = i; 
        opt.textContent = t.name;
        routeSelect.appendChild(opt);
    });
    container.style.cssText = "display: block !important; position: absolute; top: 10px; left: 60px; z-index: 9999;";
  } else {
    container.style.display = "none";
  }
  
  if (allTracks.length > 0) {
    window.multiGpxStack = allTracks;
    loadRoute(0, shouldFit);
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
      
      let utc = null;
      let localTime = "無時間資訊";
      let rawTime = null; // ✅ 新增：用來存原始字串
      
      if (timeNode && timeNode.textContent.trim() !== "") {
        rawTime = timeNode.textContent.trim(); // ✅ 直接存下原始字串如 "2026-04-23T06:24:00Z"
        const d = new Date(rawTime);
        if (!isNaN(d.getTime())) {
          utc = d;
          localTime = formatDate(new Date(utc.getTime() + 8*3600*1000));
        }
      }

      if (res.length > 0) {
        const a = res[res.length-1], R = 6371;
        const dLat = (lat-a.lat)*Math.PI/180, dLon = (lon-a.lon)*Math.PI/180;
        const x = Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(lat*Math.PI/180)*Math.sin(dLon/2)**2;
        total += 2 * R * Math.asin(Math.sqrt(Math.max(0, x)));
      }
      
      res.push({ 
        lat, 
        lon, 
        ele, 
        time: rawTime,           // ✅ 重要：匯出時會用到這個欄位
        timeUTC: utc ? utc.getTime() : null, 
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
let fsPopupTimer = null;

function setupProgressBar() {
    const barContainer = document.getElementById("map-control-bar");
    const progressBar = document.getElementById("gpxProgressBar");
    const mainCheckbox = document.getElementById("showChartTipCheckbox");
    const fsCheckbox = document.getElementById("fsShowTipCheckbox");

    if (!barContainer || !progressBar) return;

    L.DomEvent.disableClickPropagation(barContainer);
    L.DomEvent.disableScrollPropagation(barContainer);

    // --- 輔助功能：自動關閉彈窗計時器 ---
    const startAutoCloseTimer = () => {
        // 先清除之前的計時器，避免重複執行
        if (fsPopupTimer) clearTimeout(fsPopupTimer);
        // 設定 3 秒後關閉
        fsPopupTimer = setTimeout(() => {
            map.closePopup();
        }, 3000);
    };

    // --- 核心修正：讓 Checkbox 切換時「立刻」反應 ---
    const handleCheckboxChange = (isChecked) => {
        if (mainCheckbox) mainCheckbox.checked = isChecked;
        if (fsCheckbox) fsCheckbox.checked = isChecked;

        if (!isChecked) {
            map.closePopup();
            if (fsPopupTimer) clearTimeout(fsPopupTimer); // 取消勾選時也停止計時
        } else {
            const idx = parseInt(progressBar.value);
            if (typeof showCustomPopup === 'function' && trackPoints && trackPoints[idx]) {
                showCustomPopup(idx, "位置資訊");
                startAutoCloseTimer(); // 重新勾選也觸發計時
            }
        }
    };

    if (mainCheckbox) mainCheckbox.addEventListener('change', (e) => handleCheckboxChange(e.target.checked));
    if (fsCheckbox) fsCheckbox.addEventListener('change', (e) => handleCheckboxChange(e.target.checked));

    window.updateVisibility = () => {
    const barContainer = document.getElementById("map-control-bar");
    if (!barContainer) return;

    const hasTracks = (typeof trackPoints !== 'undefined' && trackPoints && trackPoints.length > 0);
    
    // 唯一顯示條件：有軌跡 且 使用者手動開啟
    if (hasTracks && window.manualShowBar) {
        barContainer.style.setProperty('display', 'flex', 'important');
        barContainer.style.visibility = 'visible'; // 確保可視性
        barContainer.style.opacity = '1';

        // 處理 iPhone 全螢幕下的定位
        const isIphoneFS = document.body.classList.contains('iphone-fullscreen');
        const isLandscape = window.innerWidth > window.innerHeight && window.innerHeight < 500;

        if (isLandscape) {
            barContainer.style.bottom = '5px';
        } else if (isIphoneFS) {
            // iPhone 全螢幕時，進度軸位置需避開底部的全螢幕退出按鈕或系統 Home Bar
            barContainer.style.bottom = '100px'; 
            barContainer.style.zIndex = '2000'; // 確保在 iPhone 全螢幕層之上
        } else {
            barContainer.style.bottom = '65px';
        }
    } else {
        barContainer.style.setProperty('display', 'none', 'important');
    }
};

    document.addEventListener('fullscreenchange', updateVisibility);
    document.addEventListener('webkitfullscreenchange', updateVisibility);

    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if (mutation.attributeName === 'class') updateVisibility();
        });
    });
    observer.observe(document.body, { attributes: true });

    // 進度條拖動事件
    progressBar.addEventListener("input", function() {
        const idx = parseInt(this.value);
        if (!trackPoints || !trackPoints[idx]) return;
        const p = trackPoints[idx];

        if (hoverMarker) {
            hoverMarker.setLatLng([p.lat, p.lon]).bringToFront();
            if (!map.getBounds().contains([p.lat, p.lon])) {
                map.panTo([p.lat, p.lon], { animate: false });
            }
        }
        document.getElementById("progressBarInfo").textContent = `${p.distance.toFixed(2)} km`;
        
        if (chart) { // 使用您的全域變數 chart
            const meta = chart.getDatasetMeta(0);
            const point = meta.data[idx];
            if (point) {
                chart.setActiveElements([{ datasetIndex: 0, index: idx }]);
                chart.tooltip.setActiveElements(
                    [{ datasetIndex: 0, index: idx }],
                    { x: point.x, y: point.y }
                );
                chart.update('none'); // 使用 'none' 模式確保拖動流暢不卡頓
            }
        }
        
        // 拖移時判斷
        const isChecked = fsCheckbox ? fsCheckbox.checked : (mainCheckbox ? mainCheckbox.checked : true);
        if (typeof showCustomPopup === 'function') {
            if (isChecked) {
                showCustomPopup(idx, "位置資訊");
                // 每次拖動時都會「刷新」計時器
                startAutoCloseTimer();
            } else {
                map.closePopup(); 
            }
        }
    });

    // 額外保險：當手指放開（結束拖動）時確保有啟動計時
    progressBar.addEventListener("change", function() {
        const isChecked = fsCheckbox ? fsCheckbox.checked : (mainCheckbox ? mainCheckbox.checked : true);
        if (isChecked) startAutoCloseTimer();
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

    const sel = (window.multiGpxStack && window.multiGpxStack[index]) 
                ? window.multiGpxStack[index] 
                : allTracks[index];
    if (!sel) return;
    
    const wptToggleContainer = document.getElementById("wptToggleContainer");
    if (wptToggleContainer) wptToggleContainer.style.display = "block";

    if (hoverMarker) {
        map.removeLayer(hoverMarker);
        hoverMarker = null;
    }

    trackPoints = sel.points || []; 
    
    const breakTracks = (pts) => {
        if (!pts || pts.length === 0) return [];
        const result = [];
        let currentSeg = [pts[0]];
        for (let j = 1; j < pts.length; j++) {
            const p1 = pts[j-1];
            const p2 = pts[j];
            const lat1 = p1.lat ?? p1[0] ?? p1.lat;
            const lng1 = p1.lng ?? p1[1] ?? p1.lng;
            const lat2 = p2.lat ?? p2[0] ?? p2.lat;
            const lng2 = p2.lng ?? p2[1] ?? p2.lng;
            const d = Math.sqrt(Math.pow(lat1 - lat2, 2) + Math.pow(lng1 - lng2, 2));
            if (d > 0.001) {
                if (currentSeg.length > 0) result.push(currentSeg);
                currentSeg = [];
            }
            currentSeg.push(p2);
        }
        if (currentSeg.length > 0) result.push(currentSeg);
        return result;
    };

    // --- 1. 處理多檔案模式圖層顯示 ---
    let finalColor = customColor || "red"; 
    if (typeof multiGpxStack !== 'undefined' && multiGpxStack.length > 0) {
        const stackIdx = (window.currentMultiIndex !== undefined) ? window.currentMultiIndex : 0;
        multiGpxStack.forEach((item, i) => {
            const layer = item.layer;
            if (!(layer instanceof L.Polyline)) return;
            const currentRawPts = layer.getLatLngs().flat(Infinity);
            layer.setLatLngs(breakTracks(currentRawPts)); 

            if (i === stackIdx) {
                const isSelectingCombined = (index === 0 || sel.name.includes("結合"));
                if (isSelectingCombined) {
                    layer.setStyle({ opacity: 0, weight: 0 });
                } else {
                    layer.setStyle({ color: item.color || "#666", opacity: 0.5, weight: 4, dashArray: "5, 8" });
                    layer.bringToBack();
                }
                if (item.color) finalColor = item.color;
            } else {
                layer.setStyle({ color: item.color || "#999", opacity: 0.5, weight: 4, dashArray: null });
                layer.bringToBack();
            }
        });
    }

    // --- 清除舊圖層 ---
    if (polyline) map.removeLayer(polyline);
    markers.forEach(m => map.removeLayer(m));
    wptMarkers.forEach(m => map.removeLayer(m));
    if (window.chart) { window.chart.destroy(); window.chart = null; }
    markers = []; wptMarkers = []; polyline = null; 

    // --- 2. 繪製目前選中的高亮軌跡 ---
    if (trackPoints && trackPoints.length > 0) {
        const segments = breakTracks(trackPoints);
        polyline = L.polyline(segments, { color: finalColor, weight: 6, opacity: 0.8 }).addTo(map);

        if (polyline.getBounds().isValid()) {
            if (!map.getBounds().pad(0.05).intersects(polyline.getBounds())) {
                map.fitBounds(polyline.getBounds(), { padding: [20, 20], maxZoom: 16, animate: true });
            }
        }

        polyline.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            let minD = Infinity, idx = 0;
            trackPoints.forEach((p, pIdx) => {
                const d = Math.sqrt((p.lat - e.latlng.lat)**2 + (p.lon - e.latlng.lng)**2);
                if (d < minD) { minD = d; idx = pIdx; }
            });
            if (minD * 111000 <= 15) {
                const progressBar = document.getElementById('gpxProgressBar');
                if (progressBar) {
                    progressBar.value = idx;
                    progressBar.dispatchEvent(new Event('input', { bubbles: true }));
                }
                if (chart) {
                    const meta = chart.getDatasetMeta(0);
                    const point = meta.data[idx];
                    if (point) {
                        chart.setActiveElements([{ datasetIndex: 0, index: idx }]);
                        chart.tooltip.setActiveElements([{ datasetIndex: 0, index: idx }], { x: point.x, y: point.y });
                        chart.update('none');
                    }
                }
                if (!hoverMarker) {
                    hoverMarker = L.circleMarker([0,0], { radius: 7, color: '#ffffff', weight: 2, fillColor: '#1a73e8', fillOpacity: 1 }).addTo(map);
                } else if (!map.hasLayer(hoverMarker)) {
                    hoverMarker.addTo(map);
                }
                hoverMarker.setLatLng([trackPoints[idx].lat, trackPoints[idx].lon]).bringToFront();
                if (typeof showCustomPopup === 'function') showCustomPopup(idx, "位置資訊", null);
            }
        });

        try {
            const startMarker = L.marker([trackPoints[0].lat, trackPoints[0].lon], { icon: startIcon, zIndexOffset: 1000 }).addTo(map);
            startMarker.on('click', (e) => { L.DomEvent.stopPropagation(e); showCustomPopup(0, "起點", null); });
            markers.push(startMarker);

            const lastIdx = trackPoints.length - 1;
            const endMarker = L.marker([trackPoints[lastIdx].lat, trackPoints[lastIdx].lon], { icon: endIcon, zIndexOffset: 1000 }).addTo(map);
            endMarker.on('click', (e) => { L.DomEvent.stopPropagation(e); showCustomPopup(lastIdx, "終點", null); });
            markers.push(endMarker);
        } catch (err) {}

        if (typeof drawElevationChart === 'function') drawElevationChart();
    }

    // --- 3. 繪製航點 (已修正：移除 200m 距離過濾) ---
    if (sel.waypoints && sel.waypoints.length > 0) {
        const activeIdx = window.currentActiveIndex || 0;

        // 計算目前選中軌跡的時間範圍
        let startTime = null, endTime = null;
        if (trackPoints && trackPoints.length > 0) {
            const times = trackPoints.map(p => p.time ? new Date(p.time).getTime() : null).filter(t => t);
            if (times.length > 0) {
                // 給予前後 1 小時緩衝
                startTime = Math.min(...times) - (60 * 60 * 1000);
                endTime = Math.max(...times) + (60 * 60 * 1000);
            }
        }

        const displayWaypoints = sel.waypoints.filter(w => {
            // A. 整合路線一律顯示
            if (activeIdx === 0) return true;
            
            // B. 手動分配的點一律顯示
            if (w.belongsToRoute !== undefined) return w.belongsToRoute === activeIdx;

            const wTimeVal = w.time ? new Date(w.time).getTime() : null;

            // C. 智慧攔截：僅針對當年(2025)登山期間但「錄錯天」的點
            if (wTimeVal && startTime) {
                const is2025Trek = new Date(wTimeVal).getFullYear() === 2025;
                const isInTimeRange = (wTimeVal >= startTime && wTimeVal <= endTime);
                
                // 如果是 2025 年錄製的點，但不在這段路的時間內，就濾掉
                if (is2025Trek && !isInTimeRange) return false;
            }

            // D. 全面放行：其餘所有點 (包含 2026 年新增的 222, 或無時間點) 無視距離顯示
            return true;
        });

        // 渲染航點 Marker
        displayWaypoints.forEach((w) => {
        	
              let tIdx = 0;
            if (trackPoints.length > 0) {
                let minD = Infinity;
                trackPoints.forEach((tp, pi) => {
                    let d = Math.sqrt((w.lat - tp.lat) ** 2 + (w.lon - tp.lon) ** 2);
                    if (d < minD) { minD = d; tIdx = pi; }
                });
            }
            
            const wm = L.marker([w.lat, w.lon], { icon: wptIcon }).addTo(map);
            const isAlways = typeof showWptNameAlways !== 'undefined' && showWptNameAlways;
            wm.bindTooltip(w.name, { 
                permanent: isAlways, 
                direction: isAlways ? 'right' : 'top', 
                offset: isAlways ? [10, 0] : [0, -10],
                className: isAlways ? 'wpt-label-label' : ''
            });
            if (isAlways) wm.openTooltip();

            wm.on('click', (e) => { 
                L.DomEvent.stopPropagation(e); 
                showCustomPopup(tIdx, w.name, "wpt", w.lat, w.lon); 
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
    if (typeof renderWaypointsAndPeaks === 'function') {
        renderWaypointsAndPeaks(sel); 
    }
    
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

        const coordBtn = createBtn('🌐', '座標轉換', true);

        const btnSize = "30px";
        const arrowIconSize = "20px";
        const arrowColor = "#1a73e8";
        const locArrowAngle = "315deg"

        const locBtn = L.DomUtil.create('a', '', container);
        locBtn.title = "目前位置定位";
        locBtn.style.cssText = `width:${btnSize}; height:${btnSize}; background:white; cursor:pointer; display:flex; align-items:center; justify-content:center; border-bottom:1px solid #ccc;`;
        
        locBtn.innerHTML = `
            <svg width="${arrowIconSize}" height="${arrowIconSize}" viewBox="0 0 100 100" style="display:block; transform: rotate(${locArrowAngle})">
                <path d="M50 5 L90 90 L50 70 L10 90 Z" fill="${arrowColor}" />
            </svg>
        `;

        const compassBtn = createBtn('🧭', '顯示/隱藏指北針', false);

        L.DomEvent.disableClickPropagation(container);
        
        L.DomEvent.on(coordBtn, 'click', (e) => { 
            L.DomEvent.stop(e); 
            
            // --- 關鍵修正：不再 removeLayer(hoverMarker) 也不再設為 null ---
            // 這樣小藍點就會一直留在地圖上

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

            const modal = document.getElementById('coordModal');
            const mapContainer = document.getElementById('map');
            
            if (!modal) return;

            if (modal.parentNode !== mapContainer) {
                mapContainer.appendChild(modal);
            }
            
            L.DomEvent.disableClickPropagation(modal);

            modal.style.zIndex = "2147483647"; 
            modal.style.position = "absolute";
            modal.style.display = 'flex'; 

            modal.innerHTML = `
    <div id="jump-container" style="background:white; padding:12px 15px; border-radius:12px; width:280px; box-shadow:0 10px 25px rgba(0,0,0,0.5); font-family: sans-serif; font-size:13px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
            <b style="color:#1a73e8;">🌐 座標跳轉定位</b>
            <span onclick="document.getElementById('coordModal').style.display='none'" style="cursor:pointer; font-size:20px; color:#999;">×</span>
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
            // 修正 1：確保小藍點在 z-index 最上層，且地圖重新整理顯示
            if (typeof hoverMarker !== 'undefined' && hoverMarker) {
                hoverMarker.bringToFront();
            }
            map.invalidateSize();

            setTimeout(() => {
                const focusEl = document.getElementById('lat_dd');
                if(focusEl) focusEl.focus();
            }, 100);
        });

        L.DomEvent.on(locBtn, 'click', (e) => { 
            L.DomEvent.stop(e); 
            window.toggleGPS(locBtn);
        });

        L.DomEvent.on(compassBtn, 'click', (e) => { 
            L.DomEvent.stop(e); 
            const compass = document.getElementById("mapCompass");
            if(compass) compass.classList.toggle("show"); 
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

/**
 * @param {number} idx - 索引
 * @param {string} title - 標題
 * @param {string|number} typeOrEle - 關鍵修正：傳入 "wpt" 強制編輯模式，或傳入高度數值
 * @param {number} realLat - 緯度
 * @param {number} realLon - 經緯度
 */
function showCustomPopup(idx, title, typeOrEle = null, realLat = null, realLon = null) {
  const isWptMode = (typeOrEle === "wpt");
  const lat = (isWptMode || realLat !== null) ? realLat : (trackPoints[idx] ? trackPoints[idx].lat : null);
  const lon = (isWptMode || realLon !== null) ? realLon : (trackPoints[idx] ? trackPoints[idx].lon : null);

  if (lat === null || lon === null) return;

  let waypointIdx = -1;
  let waypointTime = null;
  let finalTitle = title;
  let targetGpx = null;

  // --- 🔍 全域航點掃描 (維持原本邏輯) ---
  const activeIdx = (typeof window.currentActiveIndex !== 'undefined') ? window.currentActiveIndex : 0;
  let potentialSources = [];
  if (window.allTracks) potentialSources = [...window.allTracks];
  if (window.multiGpxStack) potentialSources = [...potentialSources, ...window.multiGpxStack];

  for (let gpx of potentialSources) {
      if (!gpx || !gpx.waypoints) continue;
      let foundIdx = gpx.waypoints.findIndex(w => 
          Math.abs(w.lat - lat) < 0.00015 && Math.abs(w.lon - lon) < 0.00015
      );
      if (foundIdx === -1 && title && !["軌跡點", "位置資訊", "自選位置"].includes(title)) {
          foundIdx = gpx.waypoints.findIndex(w => {
              const isSameName = (w.name === title || w.name === title.trim());
              const isNearby = Math.abs(w.lat - lat) < 0.0020 && Math.abs(w.lon - lon) < 0.0020;
              return isSameName && isNearby;
          });
      }
      if (foundIdx !== -1) {
          waypointIdx = foundIdx;
          targetGpx = gpx;
          const wptData = gpx.waypoints[waypointIdx];
          finalTitle = wptData.name;
          waypointTime = wptData.localTime || (wptData.time ? new Date(wptData.time).toLocaleString() : null);
          break;
      }
  }

  // --- 3. 校準軌跡點索引 (關鍵微調) ---
  let effectiveIdx = idx;
  let matchedPoint = (typeof trackPoints !== 'undefined' && trackPoints[idx]) ? trackPoints[idx] : null;

  // 🛡️ 修正點：如果已經確定是航點 (waypointIdx !== -1)，就不要再去自動吸附軌跡點 (避免出現不該有的距離)
  if (waypointIdx === -1) { 
      if (!matchedPoint || idx === 999999) {
          if (typeof trackPoints !== 'undefined') {
              const fIdx = trackPoints.findIndex(tp => Math.abs(tp.lat - lat) < 0.00015 && Math.abs(tp.lon - lon) < 0.00015);
              if (fIdx !== -1) { effectiveIdx = fIdx; matchedPoint = trackPoints[fIdx]; }
          }
      }
  } else {
      // 點位是航點，強制設為 999999 以防誤抓距離
      effectiveIdx = 999999;
      matchedPoint = null;
  }

  // --- 4. 設定顯示資訊 (修正高度數值與距離顯示) ---
  const offPathEle = (typeof typeOrEle === 'number') ? typeOrEle : null;
  
  let eleValue = 0;
  if (offPathEle !== null) eleValue = offPathEle;
  else if (matchedPoint && matchedPoint.ele) eleValue = matchedPoint.ele;
  else if (waypointIdx !== -1 && targetGpx) eleValue = targetGpx.waypoints[waypointIdx].ele || 0;

  // 🛡️ 如果是 0，顯示 "---"，否則顯示整數
  const eleDisplay = (eleValue !== 0) ? eleValue.toFixed(0) : "---";

  // 🛡️ 只有非航點且真正有吸附到軌跡點時，才顯示距離
  const dist = (effectiveIdx !== 999999 && matchedPoint && matchedPoint.distance !== undefined) ? matchedPoint.distance.toFixed(2) : null;
  const displayTime = waypointTime || (matchedPoint ? matchedPoint.timeLocal : null) || new Date().toLocaleString();

  // --- 5. 決定圖示與顏色 (保持原本結果) ---
  const isExisting = (waypointIdx !== -1) || isWptMode;
  const iconName = isExisting ? 'edit' : 'add_location'; 
  const iconColor = '#1a73e8';
  const safeTitle = (finalTitle || "自選位置").replace(/'/g, "\\'");

  const editIcon = `<span class="material-icons" style="font-size:16px; cursor:pointer; vertical-align:middle; margin-left:4px; color:${iconColor};" 
      onclick="event.stopPropagation(); handleWptEdit(${waypointIdx !== -1 ? waypointIdx : 'null'}, ${lat}, ${lon}, ${eleValue}, '${safeTitle}', '${displayTime}', ${effectiveIdx})">${iconName}</span>`;

  // --- 6. 渲染介面 ---
  const twd97 = proj4(WGS84_DEF, TWD97_DEF, [lon, lat]);
  const twd67 = proj4(WGS84_DEF, TWD67_DEF, [lon, lat]);
  const gUrl = `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
  const gMapIconBtn = `<a href="${gUrl}" target="_blank" style="text-decoration:none; margin-right:8px; display:inline-flex; align-items:center; justify-content:center; width: 28px; height: 28px; background: #fff; border: 1px solid #ccc; border-radius: 50%; box-shadow: 0 2px 4px rgba(0,0,0,0.2); vertical-align: middle;"><img src="https://ychiking.github.io/gpx-online-viewer/GoogleMaps.png" style="width:18px; height:18px;" alt="GMap"></a>`;

  const abButtons = `
    <div style="display:flex; margin-top:10px; gap:5px;">
      <button onclick="setAB('A', ${effectiveIdx}, ${lat}, ${lon})" style="flex:1; background:#007bff; color:white; border:none; padding:6px; border-radius:4px; cursor:pointer; font-weight:bold;">設定 A</button>
      <button onclick="setAB('B', ${effectiveIdx}, ${lat}, ${lon})" style="flex:1; background:#e83e8c; color:white; border:none; padding:6px; border-radius:4px; cursor:pointer; font-weight:bold;">設定 B</button>
    </div>`;

  let content = `
    <div style="min-width:180px; font-size:13px; line-height:1.6;">
      <div style="display:flex; align-items:center; margin-bottom:5px;">
        ${gMapIconBtn}
        <b style="font-size:14px; color:${iconColor};">${finalTitle}</b>${editIcon}
      </div>
      高度: ${eleDisplay} m<br>
      ${dist ? `距離: ${dist} km<br>` : ''}
      時間: ${displayTime}<br> 
      WGS84: ${lat.toFixed(5)}, ${lon.toFixed(5)}<br>
      TWD97: ${Math.round(twd97[0])}, ${Math.round(twd97[1])}<br>
      TWD67: ${Math.round(twd67[0])}, ${Math.round(twd67[1])}<br>
      ${(waypointIdx === -1 && effectiveIdx === 999999) ? '<span style="color:red; font-weight:bold;">⚠️ 不在路徑上</span>' : ''}
      ${abButtons}
    </div>`;

  if (currentPopup && map.hasLayer(currentPopup)) {
      currentPopup.setLatLng([lat, lon]).setContent(content);
  } else {
      currentPopup = L.popup({ autoClose: true, closeOnClick: false }).setLatLng([lat, lon]).setContent(content).openOn(map);
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
        
        const progressBar = document.getElementById("gpxProgressBar");
            if (progressBar) {
                progressBar.value = idx;
                // 同步更新旁邊的距離文字
                const info = document.getElementById("progressBarInfo");
                if (info) info.textContent = `${p.distance.toFixed(2)} km`;
            }

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
  
  // ✅ 核心修正：明確定義什麼是「非原始軌跡點」
  const isManualPoint = (idx === -1 || idx === 999999);

  // 1. 取得座標與建立點資料
  if (forcedLat !== null && forcedLon !== null) {
    // 點擊新增航點後的位置 (由 Popup 傳入座標)
    lat = forcedLat;
    lon = forcedLon;
    
    // 如果是 999999，我們只借用它的高度，而不繼承它的里程和時間
    if (trackPoints && trackPoints[idx] && !isManualPoint) {
      targetPoint = { ...trackPoints[idx], lat, lon, idx }; 
    } else {
      // ✅ 針對手動航點：保證不帶有 distance 和 timeUTC 屬性，避免 updateABUI 算錯
      const eleValue = (trackPoints[idx]) ? trackPoints[idx].ele : 0;
      targetPoint = { lat, lon, idx, ele: eleValue };
    }
  } else if (trackPoints && trackPoints[idx] && !isManualPoint) {
    // 從高度表或原始軌跡點點擊
    targetPoint = { ...trackPoints[idx], idx };
    lat = targetPoint.lat;
    lon = targetPoint.lon;
  } else if (hoverMarker) {
    // 地圖自由點擊 (未新增航點前)
    const pos = hoverMarker.getLatLng();
    lat = pos.lat;
    lon = pos.lng;
    targetPoint = { lat, lon, idx: -1, ele: 0 };
  } else {
    return;
  }

  // 2. 設定 A 或 B 點 (維持原本 Marker 邏輯)
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
    const infoA = document.getElementById("infoA"), 
          infoB = document.getElementById("infoB"), 
          boxRes = document.getElementById("boxRes"), 
          infoRes = document.getElementById("infoRes");
    
    // 統一時間格式化函式: 2026-04-18 09:54:11
    const formatDateTime = (date) => {
        if (!date) return "";
        const d = new Date(date);
        if (isNaN(d.getTime())) return date; // 如果已經是字串則直接回傳
        const pad = (num) => String(num).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };

    const getCoordHTML = (p) => {
        const twd97 = proj4(WGS84_DEF, TWD97_DEF, [p.lon, p.lat]);
        const twd67 = proj4(WGS84_DEF, TWD67_DEF, [p.lon, p.lat]);
        return `WGS84: ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}<br>
                TWD97: ${Math.round(twd97[0])}, ${Math.round(twd97[1])}<br>
                TWD67: ${Math.round(twd67[0])}, ${Math.round(twd67[1])}`;
    };

    // --- 更新 A 點資訊 ---
    if (pointA) {
        let html = getCoordHTML(pointA);
        // ✅ 修正：只要是 999999 或 -1，就視為手動點，不顯示里程
        const isRealOnPathA = (pointA.idx !== -1 && pointA.idx !== 999999);
        const timeStr = pointA.timeUTC ? formatDateTime(pointA.timeUTC) : (pointA.timeLocal || "");

        if (isRealOnPathA && pointA.ele !== undefined && pointA.distance !== undefined) {
            html += `<br><span style="color:#666;">高度: ${pointA.ele.toFixed(0)}m, 里程: ${pointA.distance.toFixed(2)}km, ${timeStr}</span>`;
        } else if (pointA.ele !== undefined) {
            html += `<br><span style="color:#666;">高度: ${pointA.ele.toFixed(0)}m, ${timeStr}</span>`;
        }
        infoA.innerHTML = html;
    } else { infoA.innerHTML = "尚未設定"; }

    // --- 更新 B 點資訊 ---
    if (pointB) {
        let html = getCoordHTML(pointB);
        const isRealOnPathB = (pointB.idx !== -1 && pointB.idx !== 999999);
        const timeStr = pointB.timeUTC ? formatDateTime(pointB.timeUTC) : (pointB.timeLocal || "");

        if (isRealOnPathB && pointB.ele !== undefined && pointB.distance !== undefined) {
            html += `<br><span style="color:#666;">高度: ${pointB.ele.toFixed(0)}m, 里程: ${pointB.distance.toFixed(2)}km, ${timeStr}</span>`;
        } else if (pointB.ele !== undefined) {
            html += `<br><span style="color:#666;">高度: ${pointB.ele.toFixed(0)}m, ${timeStr}</span>`;
        }
        infoB.innerHTML = html;
    } else { infoB.innerHTML = "尚未設定"; }

    // --- 區間分析邏輯 ---
    if (pointA && pointB) {
        boxRes.style.display = "block";
        const bearing = getBearingInfo(pointA.lat, pointA.lon, pointB.lat, pointB.lon);
        
        // 直線距離計算
        const R = 6371; 
        const dLat = (pointB.lat - pointA.lat) * Math.PI / 180;
        const dLon = (pointB.lon - pointA.lon) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(pointA.lat * Math.PI / 180) * Math.cos(pointB.lat * Math.PI / 180) *
                  Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const directDist = R * c;

        let analysisContent = "";
        let slopeText = "";

        // ✅ 修正：定義「真正的路徑分析」條件
        // 只要任一端是 -1 或 999999，isBothRealOnPath 就會是 false
        const isBothRealOnPath = (pointA.idx !== -1 && pointA.idx !== 999999 && 
                                  pointB.idx !== -1 && pointB.idx !== 999999);

        if (isBothRealOnPath) {
            const hDiff = pointB.ele - pointA.ele;
            const dDiff = Math.abs(pointB.distance - pointA.distance) * 1000;
            if (dDiff > 0) {
                const slope = (hDiff / dDiff) * 100;
                const angle = Math.atan(hDiff / dDiff) * (180 / Math.PI);
                const absSlope = Math.abs(slope).toFixed(1);
                const absAngle = Math.abs(angle).toFixed(1);
                if (slope > 0) slopeText = `<br>平均坡度：<b style="color:#d35400;">${absSlope} % (${absAngle}°) (上坡)</b>`;
                else if (slope < 0) slopeText = `<br>平均坡度：<b style="color:#28a745;">${absSlope} % (${absAngle}°) (下坡)</b>`;
                else slopeText = `<br>平均坡度：<b>0.0 % (0.0°)</b>`;
            }
        }

        // ✅ 關鍵修正：進入直線分析的判斷式
        if (!isBothRealOnPath) {
            // --- 狀況 1: 直線分析 (路徑 + 新增航點 會進這裡) ---
            analysisContent = `
                <div style="color:#d35400; font-weight:bold; margin-bottom:4px;">📍 直線分析 (非全路徑點)</div>
                直線距離：<b>${directDist.toFixed(2)} km</b>${slopeText}<br>
                移動方位：<span style="color:#007bff; font-weight:bold;">往 ${bearing.name} (${bearing.deg}°)</span>`;
        } else {
            // --- 狀況 2: 沿路區間分析 (真正的 GPX 點) ---
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
    
    // 如果兩端都是真正的非路徑點，觸發路徑分析功能
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
    路　　線：${currentRoute.name}
    <span class="material-icons" 
                    style="font-size:16px; cursor:pointer; color:#1a73e8; vertical-align:middle; margin-left:4px;" 
                    onclick="renameSubRoute(${currentTrackIdx})">edit</span><br>
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
window.renderWaypointsAndPeaks = function(currentRoute) {
    const wptListContainer = document.getElementById("wptList");
    const navShortcuts = document.getElementById("navShortcuts");
    if (!wptListContainer) return;

    let listHtml = "";
    let shortcutsHtml = "";

    const activeIdx = window.currentActiveIndex || 0;
    const route = currentRoute || (window.allTracks ? window.allTracks[activeIdx] : null);

    if (!route) {
        wptListContainer.innerHTML = "";
        return;
    }

    const currentTrackPts = route.points || [];
    const rawWaypoints = route.waypoints || [];

    // --- 🔑 關鍵修正：計算當前軌跡的時間範圍 (用於區分不同天的重複路段) ---
    let startTime = null;
    let endTime = null;
    if (currentTrackPts.length > 0) {
        const times = currentTrackPts
            .map(p => p.time ? new Date(p.time).getTime() : null)
            .filter(t => t !== null);
        if (times.length > 0) {
            // 前後緩衝 1 小時，避免航點時間與軌跡點時間微小誤差
            startTime = Math.min(...times) - (60 * 60 * 1000);
            endTime = Math.max(...times) + (60 * 60 * 1000);
        }
    }

    // ✅ 修正 2：強化的過濾邏輯
 const filteredWpts = rawWaypoints.map((w, i) => ({ ...w, originalIdx: i }))
    .filter(w => {
        // 1. 整合路線 (Index 0) 永遠顯示所有
        if (activeIdx === 0) return true;

        // 2. 歸屬標籤判定 (手動指定的優先)
        if (w.belongsToRoute !== undefined) return w.belongsToRoute === activeIdx;

        // --- 核心變數準備 ---
        const wTimeVal = w.time ? new Date(w.time).getTime() : null;
        
        // 判定是否為「原生點」 (只要座標跟名稱極接近，就視為這份檔案內建的點)
        const isNative = route.waypoints && route.waypoints.some(rawW => 
            Math.abs(rawW.lat - w.lat) < 0.0001 && 
            Math.abs(rawW.lon - w.lon) < 0.0001 && 
            String(rawW.name) === String(w.name)
        );

        // 判定是否為「當年登山錄製的點」 (時間落在軌跡起始的 48 小時內)
        const isTrekDayPoint = wTimeVal && startTime && Math.abs(wTimeVal - startTime) < (48 * 60 * 60 * 1000);
        
        // 判定是否在「當前軌跡時間區間」內
        let isInTimeRange = (startTime && endTime && wTimeVal) ? (wTimeVal >= startTime && wTimeVal <= endTime) : false;

        // --- 最終篩選門檻 (完全不看距離) ---

        if (isNative) {
            // 情況 A：如果是當年錄製的紀錄點，但不在這段路的時間內 (例如 9/14 的崩壁)
            // 我們才濾掉它。
            if (isTrekDayPoint && !isInTimeRange) {
                return false; 
            }
            // 情況 B：其餘原生點 (222, 444, 或是你手動補的點)
            // 不管距離多遠，通通顯示。
            return true;
        }

        // 情況 C：非原生點 (如果你載入了其他無關檔案的點)
        // 為了不讓地圖爆掉，非原生點我們還是稍微檢查一下距離
        const isNearby = currentTrackPts.some(tp => (Math.pow(w.lat - tp.lat, 2) + Math.pow(w.lon - tp.lon, 2)) < 0.00000324);
        return isNearby;
    });

    // --- 🔑 修正 3：徹底解決重複顯示問題 (去重) ---
    // 即使 rawWaypoints 有重複資料，同一個時間+名稱的點只顯示一次
    const uniqueWpts = filteredWpts.filter((v, i, a) => 
        a.findIndex(t => t.name === v.name && t.localTime === v.localTime) === i
    );

    // 渲染航點列表 (改用 uniqueWpts)
    if (uniqueWpts.length > 0) {
        const icon = (typeof showWptNameAlways !== 'undefined' && showWptNameAlways) ? "visibility_off" : "visibility";
        shortcutsHtml += `<button type="button" class="shortcut-btn" onclick="toggleWptNames()" style="display:inline-flex; align-items:center;"><span class="material-icons" style="font-size:18px; margin-right:4px;">${icon}</span><span>航點名稱</span></button>`;
        shortcutsHtml += `<button type="button" class="shortcut-btn" onclick="document.getElementById('anchorWpt').scrollIntoView({behavior: 'smooth'})">📍 航點列表</button>`;

        listHtml += `<h4 id="anchorWpt" style="margin: 20px 0 10px 0;">📍 航點列表 (${uniqueWpts.length})</h4>`;
        listHtml += `<table class="wpt-table"><thead><tr><th style="width:10%">#</th><th style="width:35%">時間</th><th style="width:35%">名稱</th><th style="width:20%">操作</th></tr></thead><tbody>`;
        
        uniqueWpts.forEach((w, displayIdx) => {
            const displayTime = w.localTime || (w.time ? new Date(w.time).toLocaleString() : "無時間資訊");
            
            listHtml += `<tr>
                <td><span class="wpt-link" onclick="focusWaypoint(${w.lat}, ${w.lon}, '${w.name}')">${displayIdx + 1}</span></td>
                <td>${displayTime}</td>
                <td>${w.name}</td>
                <td>
                    <span class="material-icons wpt-action-icon" onclick="handleWptEdit(${w.originalIdx}, ${w.lat}, ${w.lon}, ${w.ele || 0}, '${w.name}', '${w.localTime || ''}')">edit</span>
                    <span class="material-icons wpt-action-icon wpt-delete-icon" onclick="deleteWaypoint(${w.originalIdx})">delete</span>
                </td>
            </tr>`;
        });
        listHtml += `</tbody></table>`;
    }

    // ⛰️ 山岳偵測區塊 (保持不變)
    listHtml += `<h4 id="anchorPeak" style="margin: 30px 0 10px 0; font-size: 16px; color: #2c3e50; border-left: 5px solid #d35400; padding-left: 10px;">⛰️ 沿途山岳(200公尺內)</h4>`;
    listHtml += `
    <div id="aiPeaksSection">
        <div style="padding:15px; text-align:center; background:#f8f9fa; border:1px dashed #ccc; border-radius:8px; margin:10px 0;">
            <p style="margin-bottom:8px; color:#666; font-size:13px;">📍 已準備好偵測此路線周圍山岳</p>
            <button onclick="detectPeaksAlongRoute(true)" style="padding: 10px 25px; background: #1a73e8; color: white; border: none; border-radius: 50px; cursor: pointer; font-weight: bold; font-size: 14px; box-shadow: 0 2px 4px rgba(0,0,0,0.2); display: inline-flex; align-items: center; justify-content: center;">🔍 偵測此路線山岳</button>
        </div>
    </div>`;
    
    shortcutsHtml += `<button type="button" class="shortcut-btn" onclick="document.getElementById('anchorPeak').scrollIntoView({behavior: 'smooth'})">⛰️ 沿途山岳</button>`;

    wptListContainer.innerHTML = listHtml;
    wptListContainer.style.display = "block";
    if (navShortcuts) navShortcuts.innerHTML = shortcutsHtml;
};

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
// const multiColors = ['#FF0000', '#0000FF', '#FFA500', '#800080', '#FFD700', '#A52A2A', '#7FFF00', '#87CEFA', '#006400', '#FFC0CB'];
const multiColors = [
    '#0000FF', // 純藍
    '#FF3300', // 亮橘紅
    '#FF00FF', // 洋紅 (地圖上最不容易混淆的顏色)
    '#FFD600', // 鮮黃
    '#9C27B0', // 亮紫
    '#33FF00', // 螢光黃綠
    '#00FFFF', // 青色 (與陸地顏色反差大)
    '#E91E63', // 桃紅
    '#1A73E8', // Google 藍
    '#00E676', // 翡翠綠
    '#87CEFA'  // 天藍
];


// 提取出來的公共函式：內容完全是你原本監聽器內的邏輯，沒有任何更動
async function handleGpxFiles(files) {
    if (!files || files.length === 0) return;

    // --- 以下是你原本的清空與重置邏輯 ---
    clearEverything(); 
    if (typeof window.resetGPS === 'function') window.resetGPS();
    if (typeof polyline !== 'undefined' && polyline) map.removeLayer(polyline);

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

    // --- 這裡是你原本處理多檔匯入的核心迴圈 ---
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

        allTracks.push(gpxData);

        const color = multiColors[i % multiColors.length];
        const gpxId = "gpx_" + Date.now() + "_" + i; 

        let layer;
        let currentBounds = L.latLngBounds([]);

        if (combinedPoints.length > 0) {
            layer = L.polyline(combinedPoints.map(p => [p.lat, p.lon]), {
                color: color, 
                weight: 4, 
                opacity: 0.8, 
                gpxId: gpxId,
                trackIndex: allTracks.length - 1
            }).addTo(map);

            layer.on('click', (e) => {
                L.DomEvent.stopPropagation(e); 
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
        switchMultiGpx(0);
        
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
        
        // --- 保留你原本的 300ms 延遲渲染邏輯 ---
        setTimeout(() => {
             try {
                window.currentMultiIndex = 0;
                if (typeof loadRoute === 'function') {
                    loadRoute(0);
                }
                // 關鍵：確保進度條在匯入後重新初始化
                if (typeof setupProgressBar === 'function') setupProgressBar();
            } catch (err) {
                console.error("最終渲染失敗:", err);
            }
        }, 300);
    }
}

document.getElementById("multiGpxInput").addEventListener("change", async (e) => {
    // 呼叫公共函式處理匯入
    await handleGpxFiles(e.target.files);
    // 保留原本的行為：清空 input 值
    e.target.value = ""; 
});

function switchMultiGpx(index) {
    const data = multiGpxStack[index];
    if (!data) return;
    
    window.currentMultiIndex = index;
    map.closePopup();
    window.currentFileNameForDisplay = data.name;

    // 1. UI 樣式處理 (省略...)
    multiGpxStack.forEach((item, i) => {
        const btn = document.getElementById(`multi-btn-${i}`);
        if (i === index) {
            item.layer.setStyle({ color: item.color, weight: 8, opacity: 1.0 }).bringToFront(); 
            if (btn) btn.classList.add('active');
            if (!isGpxInView(index)) map.fitBounds(item.layer.getBounds(), { padding: [20, 20], maxZoom: 16 });
        } else {
            item.layer.setStyle({ color: item.color, weight: 5, opacity: 0.5 });
            if (btn) btn.classList.remove('active');
        }
    });

    // ✅ 定義內部的同步工具 (這就是解決 ReferenceError 的關鍵)
    const applyCustomNames = () => {
        if (data.customRouteNames && window.allTracks) {
            Object.keys(data.customRouteNames).forEach(id => {
                const trackIdx = parseInt(id);
                if (allTracks[trackIdx]) {
                    allTracks[trackIdx].name = data.customRouteNames[trackIdx];
                }
            });

            // 同步更新下拉選單文字
            const routeSelect = document.getElementById("routeSelect");
            if (routeSelect) {
                allTracks.forEach((t, i) => {
                    if (routeSelect.options[i]) routeSelect.options[i].text = t.name;
                });
            }
        }
    };

    // 2. 🔴 核心同步邏輯
    if (data.content) {
        const pureFileName = data.name.replace(/\.[^/.]+$/, "");
        
        // 執行解析 (這會重建 allTracks，導致名字變回舊的)
        parseGPX(data.content, pureFileName);
        
        // 第一次覆寫：解析完立刻蓋回
        applyCustomNames();
        
        // 同步航點
        if (allTracks && allTracks.length > 0) {
            allTracks.forEach(track => {
                track.waypoints = data.waypoints || [];
            });
        }

        setTimeout(() => {
            if (typeof loadRoute === 'function') {
                loadRoute(0);
                // 第二次覆寫：確保 loadRoute 內部渲染完後，名字依舊正確
                applyCustomNames(); 
                if (typeof renderRouteInfo === 'function') renderRouteInfo();
            }
            if (window.activeRouteLayer) activeRouteLayer.setStyle({ color: data.color });
        }, 100);

    } else {
        // 方案 B: 手動軌跡
        allTracks = [{ name: data.name, points: data.points, waypoints: data.waypoints }];
        trackPoints = data.points; 
        if (typeof loadRoute === 'function') loadRoute(0);
    }

    // 3. UI 顯示調整
    const toggleBtn = document.getElementById("toggleChartBtn");
    if (toggleBtn) toggleBtn.style.display = "block";
    document.getElementById("chartContainer").style.display = "block";
    document.getElementById("wptList").style.display = "block";

    if (typeof detectPeaksAlongRoute === 'function') {
        if (typeof peakAbortController !== 'undefined' && peakAbortController) peakAbortController.abort();
        detectPeaksAlongRoute(false); 
    }
}

function renderMultiGpxButtons() {
    const bar = document.getElementById('multiGpxBtnBar');
    if (!bar || !gpxManagerControlContainer) return;

    // --- 1. 右側管理按鈕：使用 layers 圖示 (菱形 + 倒V) ---
    if (multiGpxStack && multiGpxStack.length > 0) {
        document.body.classList.add('has-gpx-bar');
        gpxManagerControlContainer.style.display = 'block';
        
        // 使用 layers 圖示，這就是您描述的那個形狀
        gpxManagerControlContainer.innerHTML = `
            <a href="#" title="管理 GPX 顯示" style="
                background-color: white; 
                width: 35px; 
                height: 35px; 
                display: flex; 
                align-items: center; 
                justify-content: center; 
                text-decoration: none; 
                color: #333;
            ">
                <span class="material-icons" style="font-size: 25px;">layers</span>
            </a>
        `;

        L.DomEvent.off(gpxManagerControlContainer, 'click');
        L.DomEvent.on(gpxManagerControlContainer, 'click', (e) => {
            L.DomEvent.stop(e);
            showGpxManagementModal(); // 顯示管理選單
        });
    } else {
        document.body.classList.remove('has-gpx-bar');
        gpxManagerControlContainer.style.display = 'none';
    }

    // --- 2. 下方 GPX Bar：處理勾選連動 ---
    bar.innerHTML = ''; 
    
    // (原本的關閉按鈕邏輯)
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
        // 【核心邏輯】如果 visible 為 false (在 Modal 中被取消勾選)，則不顯示按鈕
        if (gpx.visible === false) {
            if (gpx.layerGroup) map.removeLayer(gpx.layerGroup); // 同步移除地圖線條
            return; 
        }

        // 確保顯示中的檔案在地圖上
        if (gpx.layerGroup && !map.hasLayer(gpx.layerGroup)) {
            map.addLayer(gpx.layerGroup);
        }

        const btn = document.createElement('button');
        btn.className = 'gpx-file-btn';
        btn.id = `multi-btn-${i}`;
        btn.textContent = gpx.name.length > 40 ? gpx.name.substring(0, 40) + "..." : gpx.name;
        btn.style.borderLeft = `5px solid ${gpx.color}`;
        btn.style.setProperty('--track-color', gpx.color);
        
        btn.onclick = (e) => {
            if (e) L.DomEvent.stopPropagation(e);
            switchMultiGpx(i);
        };
        bar.appendChild(btn);
    });

    L.DomEvent.disableClickPropagation(bar);
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

// ================= 拖放匯入支援 =================

document.addEventListener('dragover', (e) => {
    e.preventDefault(); // 必須阻斷，否則瀏覽器會跳轉頁面
    e.stopPropagation();
    document.body.style.backgroundColor = "rgba(0,0,0,0.02)"; // 輕微視覺回饋
});

document.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    document.body.style.backgroundColor = "";
});

document.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    document.body.style.backgroundColor = "";

    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
        // 過濾出 GPX 檔案
        const gpxFiles = Array.from(files).filter(f => f.name.toLowerCase().endsWith('.gpx'));
        if (gpxFiles.length > 0) {
            await handleGpxFiles(gpxFiles);
        }
    }
});

// 監聽全螢幕狀態變化：確保全螢幕切換後，進度條的拖拉座標能重新校準
document.addEventListener('fullscreenchange', () => {
    setTimeout(() => {
        if (typeof setupProgressBar === 'function') setupProgressBar();
    }, 150);
});

// --- 1. 定義全域切換函式 ---
window.changeMapSize = function(size) {
    const mapDiv = document.getElementById('map');
    window.currentMapSize = size; 

    if (document.fullscreenElement || document.webkitFullscreenElement) {
        if (document.exitFullscreen) document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    }
    document.body.classList.remove('iphone-fullscreen');
    mapDiv.classList.remove('iphone-fullscreen');
    document.body.style.overflow = '';

    const isMobile = window.innerWidth <= 768;
    let heightVal;
    if (size === 'standard') {
        heightVal = isMobile ? '45vh' : '550px'; 
    } else if (size === 'large') {
        heightVal = '85vh';
    }

    if (heightVal) mapDiv.style.height = heightVal;

    setTimeout(() => {
        map.invalidateSize({ animate: true });
        if (typeof window.updateVisibility === 'function') {
            window.updateVisibility();
        }
        
        /* 關鍵修正：移除 size === 'large' 時的 scrollIntoView。
           這樣地圖就會在原地長大，不會強制把畫面向下推，
           你上方的「匯入 GPX」按鈕區域會保持可見。
        */
    }, 400); 
};

// 監聽轉向事件：防止轉向後地圖破圖
window.addEventListener('resize', () => {
    map.invalidateSize();
    if (typeof window.updateVisibility === 'function') window.updateVisibility();
});

window.toggleFullScreen = function() {
    const mapDiv = document.getElementById('map');
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

    if (isIOS) {
        const isFull = mapDiv.classList.contains('iphone-fullscreen');
        if (!isFull) {
            mapDiv.classList.add('iphone-fullscreen');
            document.body.classList.add('iphone-fullscreen'); // 確保 body 也有 class
            document.body.style.overflow = 'hidden';
            window.currentMapSize = 'full'; // 強制同步狀態
        } else {
            mapDiv.classList.remove('iphone-fullscreen');
            document.body.classList.remove('iphone-fullscreen');
            document.body.style.overflow = '';
            window.currentMapSize = 'standard'; // 退出時預設回歸標準
        }
    } else {
        // Android / PC 邏輯維持...
        if (!document.fullscreenElement) {
            if (mapDiv.requestFullscreen) mapDiv.requestFullscreen();
            window.currentMapSize = 'full';
        } else {
            document.exitFullscreen();
            window.currentMapSize = 'standard';
        }
    }
    
    setTimeout(() => {
        map.invalidateSize();
        if (window.updateVisibility) window.updateVisibility();
    }, 300);
};

window.manualShowBar = false; 

const mapSizeCtrl = L.control({ position: 'topleft' });

mapSizeCtrl.onAdd = function() {
    const container = L.DomUtil.create('div', 'leaflet-control-group');
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.gap = '8px';

    // --- 1. 地圖大小控制組 (外框樣式) ---
    const sizeWrapper = L.DomUtil.create('div', 'leaflet-bar', container);
    sizeWrapper.style.backgroundColor = 'white';
    sizeWrapper.style.display = 'flex';
    sizeWrapper.style.flexDirection = 'column';
    sizeWrapper.style.border = '1px solid rgba(0,0,0,0.2)';

    // 用來動態更新按鈕的函式
    const renderButtons = () => {
        sizeWrapper.innerHTML = '';
        
        const isIphoneFS = document.body.classList.contains('iphone-fullscreen') || 
                           document.getElementById('map').classList.contains('iphone-fullscreen');
        const isNativeFS = !!(document.fullscreenElement || document.webkitFullscreenElement);
        const isCurrentlyFull = isIphoneFS || isNativeFS;
        const currentSize = window.currentMapSize || 'standard';

        // 圖示定義
        const iconStandard = '<span class="material-icons" style="font-size:20px; transform: rotate(45deg); display: block;">unfold_less</span>';
        const iconLarge = '<span class="material-icons" style="font-size:20px; transform: rotate(45deg); display: block;">unfold_more</span>';
        const iconExit = '<span class="material-icons" style="font-size:20px;">fullscreen_exit</span>';
        const iconFull = '<span class="material-icons" style="font-size:20px;">fullscreen</span>';

        let btnConfigs = [];

        // 嚴格執行您的規則 d, e, f
        if (isCurrentlyFull) {
            // f. 全螢幕時：放標準、大圖
            btnConfigs = [
                { html: iconStandard, val: 'standard', label: '標準' },
                { html: iconExit, val: 'large', label: '大圖' } // 大圖在全螢幕下顯示退出
            ];
        } else if (currentSize === 'standard') {
            // d. 目前標準：放大圖、全螢幕
            btnConfigs = [
                { html: iconLarge, val: 'large', label: '大圖' },
                { html: iconFull, val: 'full', label: '全螢幕' }
            ];
        } else if (currentSize === 'large') {
            // e. 目前大圖：放標準、全螢幕
            btnConfigs = [
                { html: iconStandard, val: 'standard', label: '標準' },
                { html: iconFull, val: 'full', label: '全螢幕' }
            ];
        }

        btnConfigs.forEach((cfg, index) => {
            const btn = L.DomUtil.create('a', '', sizeWrapper);
            btn.innerHTML = cfg.html;
            btn.title = cfg.label;
            btn.style.width = '30px';
            btn.style.height = '30px';
            btn.style.lineHeight = '30px';
            btn.style.textAlign = 'center';
            btn.style.display = 'flex';
            btn.style.alignItems = 'center';
            btn.style.justifyContent = 'center';
            btn.style.cursor = 'pointer';
            btn.style.backgroundColor = 'white';
            if (index === 0) btn.style.borderBottom = '1px solid #eee';

            L.DomEvent.on(btn, 'click', function(e) {
                L.DomEvent.stop(e);
                if (cfg.val === 'full') {
                    window.toggleFullScreen();
                } else {
                    if (isCurrentlyFull) {
                        window.toggleFullScreen();
                        setTimeout(() => { window.changeMapSize(cfg.val); }, 350);
                    } else {
                        window.changeMapSize(cfg.val);
                    }
                }
                // 點擊後延遲重新渲染按鈕，以符合新狀態
                setTimeout(renderButtons, 500);
            });
        });
    };

    renderButtons();

    // --- 2. Scroll Bar 開關 (樣式與上面一致) ---
    const barBtnWrapper = L.DomUtil.create('div', 'leaflet-bar', container);
    barBtnWrapper.style.backgroundColor = 'white';
    barBtnWrapper.style.border = '1px solid rgba(0,0,0,0.2)';
    barBtnWrapper.style.cursor = 'pointer';
    barBtnWrapper.style.width = '30px';
    barBtnWrapper.style.height = '30px';
    barBtnWrapper.title = '顯示/隱藏軌跡進度軸';

    const barToggleBtn = L.DomUtil.create('a', '', barBtnWrapper);
    barToggleBtn.innerHTML = '<span class="material-icons" style="font-size:20px; display:flex; align-items:center; justify-content:center; height:30px;">linear_scale</span>';

    function refreshBarBtnStyle() {
        if (window.manualShowBar) {
            barToggleBtn.style.color = '#1a73e8';
            barToggleBtn.style.backgroundColor = '#e8f0fe';
        } else {
            barToggleBtn.style.color = '#666';
            barToggleBtn.style.backgroundColor = 'white';
        }
    }
    
    refreshBarBtnStyle();

    L.DomEvent.on(barToggleBtn, 'click', function(e) {
        L.DomEvent.stop(e);
        window.manualShowBar = !window.manualShowBar;
        refreshBarBtnStyle();
        if (window.updateVisibility) window.updateVisibility();
    });

    // 監聽外部全螢幕變化（例如實體按鍵退出）
    document.addEventListener('fullscreenchange', renderButtons);
    document.addEventListener('webkitfullscreenchange', renderButtons);

    L.DomEvent.disableClickPropagation(container);
    return container;
};

mapSizeCtrl.addTo(map);


let gpxManagerControlContainer; // 全域變數

function initGpxManagerControl() {
    const GpxManagerControl = L.Control.extend({
        options: { position: 'topright' }, // 置於右側，會排在樣式按鈕下方
        onAdd: function() {
            // 建立容器，並給予 leaflet-bar 類別維持邊框樣式
            gpxManagerControlContainer = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
            gpxManagerControlContainer.id = 'gpx-manager-control';
            gpxManagerControlContainer.style.display = 'none'; // 初始隱藏
            return gpxManagerControlContainer;
        }
    });
    map.addControl(new GpxManagerControl());
}
initGpxManagerControl();

function showGpxManagementModal() {
    let modal = document.getElementById('gpxManageModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'gpxManageModal';
        modal.style.cssText = "position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:9999; display:flex; align-items:center; justify-content:center; backdrop-filter: blur(2px);";
        document.body.appendChild(modal);
    }
    modal.style.display = 'flex';

    const defaultColors = ['#0000FF', '#FF3300', '#FF00FF', '#FFD600', '#9C27B0', '#33FF00', '#00FFFF', '#E91E63', '#1A73E8', '#00E676', '#FF8C00', '#BF00FF', '#A5F2F3', '#FFF000', '#87CEFA', '#FF1493'];

    let listHtml = `
        <div style="background:white; padding:20px; border-radius:12px; width:300px; box-shadow: 0 10px 30px rgba(0,0,0,0.3); max-height: 80vh; display: flex; flex-direction: column;">
            <h3 style="margin:0 0 15px 0; font-size:18px; border-bottom:1px solid #eee; padding-bottom:10px;">管理軌跡</h3>
            <div style="flex: 1; overflow-y:auto; padding-right:5px;">`;
    
    multiGpxStack.forEach((gpx, i) => {
        const isChecked = gpx.visible !== false ? 'checked' : '';
        // 【核心邏輯】判斷是否為當前 Focus 的軌跡
        const isFocused = (window.currentMultiIndex === i);
        
        listHtml += `
            <div style="margin-bottom: 10px; border: 1px solid ${isFocused ? '#1a73e8' : '#eee'}; border-radius: 8px; padding: 10px; background: ${isFocused ? '#f0f7ff' : '#fafafa'};">
                <div style="display:flex; align-items:center; gap:12px;">
                    <input type="checkbox" id="gpx-chk-${i}" ${isChecked} ${isFocused ? 'disabled' : ''} onchange="toggleGpx(${i})" 
                        style="width:18px; height:18px; cursor: ${isFocused ? 'not-allowed' : 'pointer'};">
                    
                    <div onclick="toggleColorPicker(${i})" style="
                        width: 22px; height: 22px; background: ${gpx.color}; 
                        border-radius: 50%; cursor: pointer; border: 2px solid white; box-shadow: 0 0 0 1px #ddd;
                        flex-shrink: 0;
                    "></div>

                    <label for="gpx-chk-${i}" style="font-size:14px; font-weight:500; cursor:${isFocused ? 'default' : 'pointer'}; color:${isFocused ? '#1a73e8' : '#333'}; flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                        ${gpx.name} ${isFocused ? '<span style="font-size:11px; margin-left:5px; background:#1a73e8; color:white; padding:1px 4px; border-radius:3px;">使用中</span>' : ''}
                    </label>
                </div>
                
                <div id="picker-${i}" style="display: none; margin-top: 12px; padding: 8px; background: white; border-radius: 6px; border: 1px solid #ddd; gap: 6px; flex-wrap: wrap; justify-content: center;">
                    ${defaultColors.map(color => {
                        const isSelected = gpx.color.toUpperCase() === color.toUpperCase();
                        return `
                            <div onclick="changeGpxColor(${i}, '${color}')" style="
                                width: 24px; height: 24px; background: ${color}; 
                                border-radius: 4px; cursor: pointer; position: relative;
                                border: ${isSelected ? '2px solid #333' : '1px solid rgba(0,0,0,0.1)'};
                            ">
                                ${isSelected ? '<div style="position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); width:6px; height:6px; background:white; border-radius:50%;"></div>' : ''}
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>`;
    });

    listHtml += `</div>
            <button onclick="document.getElementById('gpxManageModal').style.display='none'" 
                style="width:100%; margin-top:15px; padding:12px; background:#1a73e8; color:white; border:none; border-radius:8px; cursor:pointer; font-size:16px; font-weight:bold;">
                完成
            </button>
        </div>`;
    modal.innerHTML = listHtml;
}

window.toggleGpx = function(index) {
    const item = multiGpxStack[index];
    if (!item) return;

    // 1. 切換顯示狀態
    if (item.visible === undefined) item.visible = true;
    item.visible = !item.visible;

    // 2. 立即處理地圖上的原始圖層
    if (item.layer) {
        if (item.visible) {
            if (!map.hasLayer(item.layer)) map.addLayer(item.layer);
        } else {
            map.removeLayer(item.layer);
        }
    }

    // 3. 【關鍵修正】如果是目前的 Focus 軌跡被取消勾選，必須清除最上層 activeRouteLayer
    if (!item.visible && window.currentMultiIndex === index) {
        if (window.activeRouteLayer) {
            map.removeLayer(window.activeRouteLayer);
            window.activeRouteLayer = null;
        }
        if (window.hoverMarker) map.removeLayer(window.hoverMarker);
        
        // 隱藏高度表與相關資訊
        const chartContainer = document.getElementById("chartContainer");
        if (chartContainer) chartContainer.style.display = "none";
        const wptList = document.getElementById("wptList");
        if (wptList) wptList.style.display = "none";
    }

    // 4. 重新渲染管理視窗與下方 Bar (這會讓按鈕消失)
    showGpxManagementModal();
    renderMultiGpxButtons();
};

window.changeGpxColor = function(index, newColor) {
    const item = multiGpxStack[index];
    if (!item) return;

    item.color = newColor;

    // 1. 更新底層圖層顏色 (前提是它目前應該在地圖上)
    if (item.layer && item.visible !== false) {
        const isCurrent = (window.currentMultiIndex === index);
        item.layer.setStyle({
            color: newColor,
            opacity: isCurrent ? 1.0 : 0.5,
            weight: isCurrent ? 8 : 4
        });
    }

    // 2. 如果是正在 Focus 的軌跡，且「它是顯示狀態」，才執行重繪
    if (window.currentMultiIndex === index && item.visible !== false) {
        if (window.activeRouteLayer) {
            map.removeLayer(window.activeRouteLayer);
        }
        window.currentTrackColor = newColor;
        
        // 強制重繪
        setTimeout(() => {
            switchMultiGpx(index); 
        }, 10);
    }

    // 3. 刷新 UI
    showGpxManagementModal();
    renderMultiGpxButtons();
};

window.toggleColorPicker = function(i) {
    // 取得當前點擊的選單
    const targetPicker = document.getElementById(`picker-${i}`);
    const isCurrentlyHidden = (targetPicker.style.display === 'none');

    // 關閉所有人的選單
    multiGpxStack.forEach((_, idx) => {
        const p = document.getElementById(`picker-${idx}`);
        if (p) p.style.display = 'none';
    });

    // 如果剛才是關掉的，現在就打開它
    if (isCurrentlyHidden) {
        targetPicker.style.display = 'flex';
    }
};

let currentEditTask = null;

window.handleWptEdit = function(existingIdx, lat, lon, ele, oldName, timeStr, originalIdx) {
    // --- 原本的資料結構初始化 (保持不變) ---
    if (typeof window.currentMultiIndex === 'undefined') window.currentActiveIndex = 0; // 修正變數名稱一致性
    let stackIdx = window.currentMultiIndex || 0;
    if (typeof multiGpxStack === 'undefined' || !multiGpxStack) window.multiGpxStack = [];
    if (!multiGpxStack[stackIdx]) {
        multiGpxStack[stackIdx] = { name: "手動新增航點", points: [], waypoints: [], stats: { totalDistance: 0, totalElevation: 0 }, isCombined: false };
    }
    if (typeof allTracks === 'undefined' || !allTracks || allTracks.length === 0) {
        window.allTracks = [multiGpxStack[stackIdx]];
    }
    let activeIdx = window.currentActiveIndex || 0;
    if (!allTracks[activeIdx]) activeIdx = 0;

    // --- Modal 處理邏輯 ---
    const modal = document.getElementById('wptEditModal');
    const nameInput = document.getElementById('modalWptName');
    const eleInput = document.getElementById('modalWptEle');
    const confirmBtn = document.getElementById('modalWptConfirm');

    nameInput.value = oldName || "";
    eleInput.value = (ele !== null && ele !== "---") ? ele : 0;
    modal.style.display = 'flex';

    // ✅ 修改點 1：自動聚焦並「全選內容」
    setTimeout(() => { 
        nameInput.focus();
        nameInput.select(); // 自動全選
    }, 100);

    // 儲存參數
    currentEditTask = { existingIdx, lat, lon, ele, oldName, timeStr, originalIdx, stackIdx, activeIdx };

    // 定義關閉 Modal 的清理函式
    const closeModal = () => {
        modal.style.display = 'none';
        window.removeEventListener('keydown', handleEscKey); // ✅ 移除 ESC 監聽
        nameInput.onkeydown = null;
        eleInput.onkeydown = null;
    };

    // ✅ 修改點 2：支援 ESC 鍵離開
    const handleEscKey = (e) => {
        if (e.key === "Escape") {
            closeModal();
        }
    };
    window.addEventListener('keydown', handleEscKey);

    // Enter 鍵支援函式
    const handleEnterKey = (e) => {
        if (e.key === "Enter" || e.keyCode === 13) {
            e.preventDefault();
            confirmBtn.click();
        }
    };

    // 綁定鍵盤事件到輸入框
    nameInput.onkeydown = handleEnterKey;
    eleInput.onkeydown = handleEnterKey;

    // 綁定確認按鈕
    confirmBtn.onclick = function() {
        const finalName = nameInput.value.trim() || "未命名航點";
        const finalEle = eleInput.value;

        // 執行存檔邏輯
        processSave(finalName, finalEle);
        
        closeModal(); // ✅ 使用清理函式關閉
    };
};

// 這是從你原本程式碼拆出來的後半段存檔邏輯
function processSave(finalName, finalEle) {
    const { existingIdx, lat, lon, timeStr, originalIdx, stackIdx, activeIdx } = currentEditTask;

    // ✅ 修正 1：統一格式化函式，確保輸出為 YYYY-MM-DD HH:mm:ss
    const formatToStandard = (dateInput) => {
        const d = new Date(dateInput);
        if (isNaN(d.getTime())) return dateInput; 
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };

    const getNowStr = () => formatToStandard(new Date());

    let targetWpt;
    if (existingIdx !== null && existingIdx !== -1 && multiGpxStack[stackIdx].waypoints[existingIdx]) {
        multiGpxStack[stackIdx].waypoints[existingIdx].name = finalName;
        multiGpxStack[stackIdx].waypoints[existingIdx].ele = parseFloat(finalEle);
        targetWpt = multiGpxStack[stackIdx].waypoints[existingIdx];
    } else {
        targetWpt = { 
            lat, lon, name: finalName, isCustom: true, belongsToRoute: activeIdx,
            time: new Date().toISOString(), 
            localTime: getNowStr(), // 使用新的格式
            ele: parseFloat(finalEle) || 0
        };
        
        if (originalIdx !== null && originalIdx !== undefined && timeStr) {
            // ✅ 修正 2：繼承舊時間時也強制格式化，避免斜線格式流進來
            const formattedTime = formatToStandard(timeStr);
            targetWpt.time = formattedTime;
            targetWpt.localTime = formattedTime;
        }
        multiGpxStack[stackIdx].waypoints.push(targetWpt);
    }

    // 更新列表與地圖 (保留原本邏輯)
    allTracks.forEach(track => { track.waypoints = multiGpxStack[stackIdx].waypoints; });
    try {
        if (typeof updateWptTable === 'function') updateWptTable();
        if (typeof renderWaypointsAndPeaks === 'function') renderWaypointsAndPeaks(allTracks[activeIdx]);
    } catch (e) {}

    // 地圖 Marker 處理
    if (existingIdx !== null && existingIdx !== -1) {
        // 修改舊點：最好的做法是刷新整條路線的 Marker，避免重疊
        if (typeof loadRoute === 'function') {
            loadRoute(activeIdx); 
        }
    } else {
        // 新增點：先檢查是否已經有 Marker 陣列，並確保它被管理
        const marker = L.marker([lat, lon], { 
            icon: (typeof wptIcon !== 'undefined' ? wptIcon : new L.Icon.Default()) 
        }).addTo(map);

        marker.bindTooltip(finalName, { 
            permanent: (typeof showWptNameAlways !== 'undefined' ? showWptNameAlways : false), 
            direction: 'top', offset: [0, -10] 
        });

        if (window.showWptNameAlways) marker.openTooltip();

        marker.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            showCustomPopup(null, finalName, finalEle, lat, lon);
        });

        if (typeof wptMarkers !== 'undefined') {
            wptMarkers.push(marker);
        }
    }
    
    setTimeout(() => { showCustomPopup(null, finalName, finalEle, lat, lon); }, 200);
}


window.deleteWaypoint = function(idx) {
    const modal = document.getElementById('deleteConfirmModal');
    
    if (!modal) {
        console.error("❌ 錯誤：找不到 id 為 'deleteConfirmModal' 的 HTML 元素！");
        return;
    }
    const confirmBtn = document.getElementById('modalDeleteConfirm');
    const cancelBtn = document.getElementById('modalDeleteCancel');

    // 1. 顯示視窗
    modal.style.display = 'flex';

    // 2. 綁定「確定刪除」按鈕
    confirmBtn.onclick = function() {
        executeDelete(idx);
        modal.style.display = 'none';
    };

    // 3. 綁定「取消」按鈕
    cancelBtn.onclick = function() {
 
        modal.style.display = 'none';
    };

};

// 實際執行刪除的函式 (包含原本所有的同步與渲染邏輯)
function executeDelete(idx) {
    const stackIdx = (typeof window.currentMultiIndex !== 'undefined') ? window.currentMultiIndex : 0;
    const currentStackItem = multiGpxStack[stackIdx];

    if (!currentStackItem || !currentStackItem.waypoints) return;

    // 執行刪除
    currentStackItem.waypoints.splice(idx, 1);

    // 同步到 allTracks
    if (typeof allTracks !== 'undefined' && Array.isArray(allTracks)) {
        allTracks.forEach(track => {
            track.waypoints = currentStackItem.waypoints;
        });
    }

    // 重新渲染航點列表
    if (typeof renderWaypointsAndPeaks === 'function') {
        renderWaypointsAndPeaks(allTracks[window.currentActiveIndex || 0]);
    }

    // 重新整理地圖上的圖層
    if (typeof loadRoute === 'function') {
        loadRoute(window.currentActiveIndex || 0); 
    }
    
    // 關閉目前開啟中的 Popup
    if (typeof currentPopup !== 'undefined' && currentPopup) map.closePopup();
}

// 確保這段程式碼在 app.js 的最頂層或最末端（非內部函式）
window.downloadCounters = window.downloadCounters || {};

window.exportGpx = function(index) {
    // 1. 取得主索引 (多檔匯入時的檔案索引)
    const idx = (index !== undefined) ? index : (window.currentMultiIndex || 0);
    
    // 取得當前檔案的原始項目 (包含原始 points 與 waypoints)
    const item = (typeof multiGpxStack !== 'undefined' && multiGpxStack) ? multiGpxStack[idx] : null;

    // 2. 決定子路線索引 (對應 Select 下拉選單)
    const routeSelect = document.getElementById("routeSelect");
    let currentTrackIdx = 0; 
    if (routeSelect && routeSelect.value !== "" && !isNaN(parseInt(routeSelect.value))) {
        currentTrackIdx = parseInt(routeSelect.value);
    }

    // 3. 取得目標路線 (目前選中的這條路徑)
    let currentRoute = (typeof allTracks !== 'undefined') ? allTracks[currentTrackIdx] : null;
    
    // 補救邏輯：如果 allTracks 沒東西但 stack 有，指向 stack
    if (!currentRoute && item) {
        currentRoute = item;
    }

    if (!currentRoute) {
        alert("找不到可匯出的資料內容。");
        return;
    }

    // 決定匯出檔名
    const trackName = (currentRoute && currentRoute.name && currentRoute.name !== "手動編輯地圖") 
                    ? currentRoute.name : (item ? item.name : "Exported_Route");

    // XML 標頭 (UTF-8)
    let gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="YCHiking" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${trackName}</name></metadata>`;

    // 4. 處理軌跡 (Tracks)
    let tracksToExport = [];
    if (currentRoute && currentRoute.isCombined) {
        // 如果選到的是「結合版」，則匯出所有子路線
        tracksToExport = allTracks.filter(t => !t.isCombined);
    } else {
        tracksToExport = [currentRoute];
    }

    tracksToExport.forEach((route) => {
        const pts = route.points || [];
        if (pts.length > 0) {
            gpx += `\n  <trk><name>${route.name || "Track"}</name><trkseg>`;
            pts.forEach(p => {
                let timeTag = "";
                if (p.time) { 
                    timeTag = `<time>${p.time}</time>`;
                } else if (p.timeUTC) { 
                    timeTag = `<time>${new Date(p.timeUTC).toISOString()}</time>`;
                }
                const eleTag = `<ele>${p.ele || 0}</ele>`;
                gpx += `\n      <trkpt lat="${p.lat}" lon="${p.lon}">${eleTag}${timeTag}</trkpt>`;
            });
            gpx += `\n    </trkseg>\n  </trk>`;
        }
    });

    // 5. 處理航點 (Waypoints) - 這裡改為「全數保留，不進行任何過濾」
    let wpts = [];
    
    if (currentRoute && currentRoute.isCombined) {
        // 結合版：收集所有路線的航點
        allTracks.forEach(t => {
            if (t.waypoints) wpts = wpts.concat(t.waypoints);
        });
    } else {
        // 單一檔案：優先從 currentRoute 拿，沒有就從原始 item 拿
        wpts = currentRoute.waypoints || (item ? item.waypoints : []);
    }

    // --- 🚀 移除所有過濾邏輯 🚀 ---
    // 不再檢查距離 (isNearby)、不再檢查時間 (isInTimeRange)
    // 只要 wpts 陣列裡有點，就通通匯出

    // 僅保留「去重複」邏輯，防止同一個點因為代碼重複運行而被寫入兩次
    const uniqueWptsMap = new Map();
    wpts.forEach(w => {
        const key = `${w.lat}_${w.lon}_${w.name}`;
        if (!uniqueWptsMap.has(key)) {
            uniqueWptsMap.set(key, w);
        }
    });

    uniqueWptsMap.forEach((w) => {
        let timeTag = "";
        // 優先保留原始時間，若無則嘗試轉換 localTime
        if (w.time) {
            timeTag = `<time>${w.time}</time>`;
        } else if (w.timeUTC) {
            timeTag = `<time>${new Date(w.timeUTC).toISOString()}</time>`;
        } else if (w.localTime && w.localTime !== "無時間資訊") {
            try {
                const normalizedDate = w.localTime.replace(/\//g, '-').replace(/上午|下午/g, '');
                const d = new Date(normalizedDate);
                if (!isNaN(d.getTime())) timeTag = `<time>${d.toISOString()}</time>`;
            } catch(e) {}
        }

        gpx += `\n  <wpt lat="${w.lat}" lon="${w.lon}">
    <ele>${w.ele || 0}</ele>
    <name>${w.name || "未命名"}</name>
    ${timeTag}
  </wpt>`;
    });

    gpx += `\n</gpx>`;

    // 6. 執行下載 (加上 \ufeff 解決 UltraEdit 亂碼問題)
    try {
        // \ufeff 是 UTF-8 的 BOM 標記，能讓編輯器強制識別為 UTF-8
        const blob = new Blob(["\ufeff" + gpx], { type: 'application/gpx+xml;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const safeName = trackName.replace(/[/\\?%*:|<>]/g, '-');
        const fileName = safeName.toLowerCase().endsWith('.gpx') ? safeName : `${safeName}.gpx`;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (err) {
        console.error("匯出失敗:", err);
    }
};

window.renameSubRoute = function(idx) {
    const targetRoute = allTracks[idx];
    if (!targetRoute) return;

    const modal = document.getElementById('renameModal');
    const input = document.getElementById('modalRouteName');
    const confirmBtn = document.getElementById('modalRouteConfirm');

    if (!modal || !input || !confirmBtn) return;

    const oldName = targetRoute.name;
    input.value = oldName;
    modal.style.display = 'flex';

    // ✅ 修改點 1：自動聚焦並「全選內容」
    setTimeout(() => {
        input.focus();
        input.select(); // 自動全選，方便直接覆蓋新名稱
    }, 100);

    // 定義關閉 Modal 的清理函式
    const closeModal = () => {
        modal.style.display = 'none';
        window.removeEventListener('keydown', handleEscKey); // ✅ 移除全域 ESC 監聽
        input.onkeydown = null;
    };

    // ✅ 修改點 2：支援 ESC 鍵離開
    const handleEscKey = (e) => {
        if (e.key === "Escape") {
            closeModal();
        }
    };
    window.addEventListener('keydown', handleEscKey);

    // 支援按 Enter 鍵確認
    input.onkeydown = function(e) {
        if (e.key === "Enter" || e.keyCode === 13) {
            e.preventDefault();
            confirmBtn.click();
        }
    };

    confirmBtn.onclick = function() {
        const newName = input.value.trim();
        
        if (newName !== "" && newName !== oldName) {
            const finalName = newName;
            
            // 1. 修改數據
            targetRoute.name = finalName;

            // 2. 存入筆記本 (multiGpxStack)
            if (window.multiGpxStack && window.multiGpxStack[window.currentMultiIndex]) {
                const data = window.multiGpxStack[window.currentMultiIndex];
                if (!data.customRouteNames) data.customRouteNames = {};
                data.customRouteNames[idx] = finalName;
            }

            // 3. 更新選單文字
            const routeSelect = document.getElementById("routeSelect");
            if (routeSelect && routeSelect.options[idx]) {
                routeSelect.options[idx].text = finalName;
            }

            // 4. 刷新 Summary (renderRouteInfo)
            if (typeof renderRouteInfo === 'function') {
                renderRouteInfo();
            }
        }
        
        closeModal(); // ✅ 使用清理函式關閉並移除監聽
    };
};

// --- 1. 修改 Leaflet 控制項 (加入 ESC 監聽) ---
const searchControl = L.control({ position: 'topright' });

searchControl.onAdd = function() {
    const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
    container.innerHTML = `
        <a href="#" title="搜尋地點" style="background-color: white; width: 35px; height: 35px; display: flex; align-items: center; justify-content: center; text-decoration: none; color: #333;">
            <span class="material-icons" style="font-size: 22px;">search</span>
        </a>
    `;

    L.DomEvent.disableClickPropagation(container);

    container.onclick = function(e) {
        e.preventDefault();
        const modal = document.getElementById('searchModal');
        const input = document.getElementById('searchInput');
        
        modal.style.display = 'flex';
        input.value = ""; 

        // ✅ 修改點 1：自動聚焦並全選
        setTimeout(() => {
            input.focus();
            input.select();
        }, 100);

        // ✅ 修改點 2：開啟時綁定 ESC 鍵監聽
        window.addEventListener('keydown', handleSearchEsc);
    };

    return container;
};

searchControl.addTo(map);

// ✅ 新增：統一的關閉函式，確保移除監聽
function closeSearchModal() {
    const modal = document.getElementById('searchModal');
    const suggestionBox = document.getElementById('searchSuggestions');
    modal.style.display = 'none';
    if (suggestionBox) suggestionBox.style.display = 'none';
    
    // 移除監聽，避免平時按 ESC 影響地圖操作
    window.removeEventListener('keydown', handleSearchEsc);
}

// ✅ 新增：處理 ESC 按下事件
function handleSearchEsc(e) {
    if (e.key === "Escape") {
        closeSearchModal();
    }
}

// --- 2. 搜尋處理 (原本的邏輯幾乎不動，只需改最後關閉視窗的那幾行) ---

const searchConfirmBtn = document.getElementById('searchConfirmBtn');
const searchInput = document.getElementById('searchInput');
const searchStatus = document.getElementById('searchStatus');

// 建立建議列表容器 (維持原本邏輯)
let suggestionBox = document.getElementById('searchSuggestions');
if (!suggestionBox) {
    suggestionBox = document.createElement('div');
    suggestionBox.id = 'searchSuggestions';
    suggestionBox.style.cssText = "position:absolute; background:white; width:100%; border:1px solid #ccc; z-index:10000; display:none; max-height:200px; overflow-y:auto; box-shadow:0 2px 4px rgba(0,0,0,0.2);";
    searchInput.parentNode.style.position = 'relative';
    searchInput.parentNode.appendChild(suggestionBox);
}

// 防抖與建議列表 (維持原本邏輯)
let debounceTimer;
searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const query = searchInput.value.trim();
    if (query.length < 2) {
        suggestionBox.style.display = 'none';
        return;
    }
    debounceTimer = setTimeout(() => {
        fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5`)
            .then(res => res.json())
            .then(data => renderSuggestions(data));
    }, 400);
});

function renderSuggestions(data) {
    suggestionBox.innerHTML = '';
    if (data.length === 0) {
        suggestionBox.style.display = 'none';
        return;
    }
    data.forEach(item => {
        const div = document.createElement('div');
        div.style.padding = '8px 12px'; div.style.cursor = 'pointer'; div.style.borderBottom = '1px solid #eee';
        div.innerText = item.display_name;
        div.onmouseover = () => div.style.background = '#f0f0f0';
        div.onmouseout = () => div.style.background = 'white';
        div.onclick = () => {
            searchInput.value = item.display_name;
            suggestionBox.style.display = 'none';
            handleSearchResult(item); 
        };
        suggestionBox.appendChild(div);
    });
    suggestionBox.style.display = 'block';
}

// 修改後的 handleSearchResult
function handleSearchResult(result) {
    const lat = parseFloat(result.lat);
    const lon = parseFloat(result.lon);
    const addressArray = result.display_name.split(', ');
    const placeTitle = addressArray[0];
    const fullAddress = addressArray.slice(1).join(', ');

    let foundWptIdx = -1;
    const activeIdx = window.currentActiveIndex || 0;
    const currentGpx = (window.allTracks && window.allTracks[activeIdx]) ? window.allTracks[activeIdx] : null;

    if (currentGpx && currentGpx.waypoints) {
        foundWptIdx = currentGpx.waypoints.findIndex(w => 
            Math.abs(w.lat - lat) < 0.0001 && Math.abs(w.lon - lon) < 0.0001
        );
    }

    map.setView([lat, lon], 14);

    if (foundWptIdx !== -1) {
        showCustomPopup(foundWptIdx, placeTitle, null, lat, lon);
    } else {
        showFreeClickPopup(L.latLng(lat, lon), placeTitle, fullAddress);
    }

    // ✅ 修改點 3：改用統一關閉函式
    closeSearchModal();
    searchStatus.innerText = "輸入關鍵字後按下搜尋。";
    searchStatus.style.color = "#666";
}

function performSearch() {
    const query = searchInput.value.trim();
    if (!query) return;
    searchStatus.innerText = "搜尋中...";
    searchStatus.style.color = "#1a73e8";
    fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}`)
        .then(res => res.json())
        .then(data => {
            if (data && data.length > 0) handleSearchResult(data[0]);
            else {
                searchStatus.innerText = "找不到該地點，請嘗試其他關鍵字";
                searchStatus.style.color = "#e74c3c";
            }
        })
        .catch(err => {
            searchStatus.innerText = "連線發生錯誤，請稍後再試";
            searchStatus.style.color = "#e74c3c";
        });
}

// 點擊外面隱藏 (維持邏輯)
document.addEventListener('click', (e) => {
    if (e.target !== searchInput) suggestionBox.style.display = 'none';
});

searchConfirmBtn.onclick = performSearch;
searchInput.onkeydown = function(e) {
    if (e.key === "Enter") performSearch();
};