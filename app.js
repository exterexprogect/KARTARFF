// Инициализация карты
const map = L.map('map', {
    zoomSnap: 0.5,
    zoomDelta: 0.7,
    wheelPxPerZoomLevel: 100
}).setView([61.5, 96.5], 4.2);

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd',
    maxZoom: 12,
    attribution: ''
}).addTo(map);

// Глобальные переменные
let regions = [];
let selectedIdx = null;
let geoLayer = null;
let labelItems = [];
let statusHistory = new Map();
let lastGlobalChange = new Date();

const API_URL = 'https://radar.ra5cq.ru/api/state';

// Время
function updateClock() {
    const now = new Date();
    const msk = new Date(now.getTime() + (3 * 3600000) + (now.getTimezoneOffset() * 60000));
    document.getElementById('currentTime').innerText = msk.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    document.getElementById('currentDate').innerText = msk.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
    document.getElementById('summaryTime').innerHTML = `Сводка на ${msk.toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit' })}`;
}
updateClock();
setInterval(updateClock, 30000);

// Обновление стиля региона (КРАСИТ!)
function updateRegionStyle(idx) {
    const reg = regions[idx];
    const colors = DANGER_COLORS[reg.dangerLevel];
    const isSelected = (idx === selectedIdx);
    reg.layer.setStyle({
        fillColor: colors.fill,
        fillOpacity: isSelected ? 0.92 : 0.78,
        color: isSelected ? '#ffffff' : colors.border,
        weight: isSelected ? 2.8 : 1.4,
        dashArray: isSelected ? '5,3' : ''
    });
}

function refreshAllStyles() {
    regions.forEach((_, idx) => updateRegionStyle(idx));
}

// Загрузка GeoJSON
function loadGeoJSON() {
    const geoUrl = 'https://raw.githubusercontent.com/codeforamerica/click_that_hood/master/public/data/russia.geojson';
    fetch(geoUrl)
        .then(r => r.json())
        .then(data => processGeoJSON(data))
        .catch(() => {
            fetch('https://raw.githubusercontent.com/d3coder/geojson-russia/master/russia_regions.geojson')
                .then(r => r.json())
                .then(data => processGeoJSON(data))
                .catch(e => console.error('GeoError', e));
        });
}

function processGeoJSON(geojson) {
    if (geoLayer) map.removeLayer(geoLayer);
    regions = [];
    const features = geojson.features || [];
    
    geoLayer = L.geoJSON(geojson, {
        style: () => ({ fillColor: '#1a1a1a', fillOpacity: 0.75, color: '#3e3e48', weight: 1.2 }),
        onEachFeature: (feature, layer) => {
            let raw = feature.properties?.name || feature.properties?.NAME || feature.properties?.region || 'Регион';
            let regionName = raw;
            if (raw.includes('Moscow')) regionName = 'Московская обл.';
            if (raw.includes('Petersburg')) regionName = 'Ленинградская обл.';
            if (raw === 'Perm Krai') regionName = 'Пермский край';
            if (raw === 'Krasnodar Krai') regionName = 'Краснодарский край';
            if (raw === 'Republic of Tatarstan') regionName = 'Республика Татарстан';
            if (raw === 'Republic of Crimea') regionName = 'Республика Крым';
            
            const entry = {
                name: regionName,
                layer: layer,
                dangerLevel: 'clear',
                lastChanged: new Date(),
                apiMatch: getApiName(regionName)
            };
            const idx = regions.length;
            regions.push(entry);
            layer.setStyle({ fillColor: '#1a1a1a', color: '#3a3a48' });
            
            layer.on('click', (e) => {
                L.DomEvent.stopPropagation(e);
                selectRegion(idx);
                try {
                    const bounds = layer.getBounds();
                    if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 7 });
                } catch(e) {}
            });
            
            layer.on('mouseover', () => {
                if (selectedIdx !== idx) {
                    const colors = DANGER_COLORS[entry.dangerLevel];
                    layer.setStyle({ fillOpacity: 0.88, weight: 1.5, color: colors.border });
                }
                layer.bindTooltip(`<b>${entry.name}</b><br>${DANGER_COLORS[entry.dangerLevel].name}`, { 
                    className: 'region-tooltip', 
                    direction: 'top' 
                }).openTooltip();
            });
            
            layer.on('mouseout', () => {
                if (selectedIdx !== idx) {
                    const colors = DANGER_COLORS[entry.dangerLevel];
                    layer.setStyle({ fillOpacity: 0.75, weight: 1.2, color: colors.border });
                }
                layer.closeTooltip();
            });
        }
    }).addTo(map);
    
    setTimeout(() => {
        try { map.fitBounds(geoLayer.getBounds(), { padding: [30, 30] }); } catch(e) {}
        createStaticLabels();
    }, 200);
    
    fetchApiAndUpdate();
}

// API запрос и применение цветов
async function fetchApiAndUpdate() {
    try {
        const resp = await fetch(API_URL);
        if (!resp.ok) throw new Error('API error');
        const data = await resp.json();
        
        if (!Array.isArray(data)) {
            console.warn('API вернул не массив');
            return;
        }
        
        let anyChange = false;
        
        for (let i = 0; i < regions.length; i++) {
            const reg = regions[i];
            let foundLevel = null;
            
            for (const item of data) {
                let apiRegion = item.region || item.name || item.region_name;
                if (!apiRegion) continue;
                const apiLower = apiRegion.toLowerCase();
                const regMatch = reg.apiMatch.toLowerCase();
                const regName = reg.name.toLowerCase();
                
                if (apiLower.includes(regMatch) || regMatch.includes(apiLower) ||
                    apiLower.includes(regName) || regName.includes(apiLower)) {
                    let alarm = 'clear';
                    if (item.status === 'rocket' || item.level === 'rocket' || item.alert === 'rocket') alarm = 'rocket';
                    else if (item.status === 'drone' || item.level === 'drone' || item.alert === 'drone') alarm = 'drone';
                    else if (item.status === 'warning' || item.level === 'warning' || item.alert === 'warning') alarm = 'warning';
                    foundLevel = alarm;
                    break;
                }
            }
            
            if (foundLevel && foundLevel !== reg.dangerLevel)
