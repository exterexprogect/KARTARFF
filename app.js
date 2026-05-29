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
            
            if (foundLevel && foundLevel !== reg.dangerLevel) {
                const oldLevel = reg.dangerLevel;
                reg.dangerLevel = foundLevel;
                reg.lastChanged = new Date();
                anyChange = true;
                statusHistory.set(reg.name, { 
                    prevLevel: oldLevel, 
                    newLevel: foundLevel, 
                    changeTime: new Date() 
                });
                updateRegionStyle(i);
            }
        }
        
        if (anyChange) {
            lastGlobalChange = new Date();
            updateLastChangeBadge();
            updateSummaryUI();
            renderRecentChanges();
            if (selectedIdx !== null) updateSelectedInfoUI();
            showToast('✅ Данные API применены, статусы обновлены');
        }
        
        refreshAllStyles();
        
    } catch (err) {
        console.error('API error:', err);
        document.getElementById('alertList').innerHTML = '<span style="color:#aa6666;">⚠️ Нет связи с API</span>';
        showToast('❌ Ошибка подключения к API');
    }
}

function showToast(msg) {
    let toast = document.getElementById('toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast';
        toast.style.cssText = 'position:fixed;bottom:20px;left:20px;background:#1a1a1a;color:#0f0;padding:8px 16px;border-radius:20px;font-size:12px;z-index:2000;font-family:monospace;border:1px solid #0f0;';
        document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.display = 'block';
    setTimeout(() => { toast.style.display = 'none'; }, 3000);
}

function renderRecentChanges() {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    let changedList = [];
    for (let [regionName, record] of statusHistory.entries()) {
        if (record.changeTime > oneHourAgo && record.prevLevel !== record.newLevel) {
            let icon = '';
            if (record.newLevel === 'rocket') icon = '🚀';
            else if (record.newLevel === 'drone') icon = '✈️';
            else if (record.newLevel === 'warning') icon = '⚠️';
            else if (record.newLevel === 'clear') icon = '✅';
            changedList.push(`${icon} ${regionName} → ${DANGER_COLORS[record.newLevel].name}`);
        }
    }
    const changesDiv = document.getElementById('changesList');
    if (changedList.length === 0) {
        changesDiv.innerHTML = '<span style="color:#888;">—</span>';
    } else {
        changesDiv.innerHTML = changedList.slice(0, 8).join('<br>');
    }
}

function updateLastChangeBadge() {
    const badge = document.getElementById('apiLastUpdateLabel');
    const timeStr = lastGlobalChange.toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    badge.innerHTML = `⏱️ Последнее изменение: ${timeStr}`;
}

function updateSummaryUI() {
    const rockets = regions.filter(r => r.dangerLevel === 'rocket');
    const drones = regions.filter(r => r.dangerLevel === 'drone');
    const warnings = regions.filter(r => r.dangerLevel === 'warning');
    
    const alertDiv = document.getElementById('alertList');
    if (rockets.length + drones.length === 0) {
        alertDiv.innerHTML = '<span style="color:#888;">Нет активных тревог</span>';
    } else {
        let txt = '';
        rockets.forEach(r => txt += `🚀 ${r.name}\n`);
        drones.forEach(r => txt += `✈️ ${r.name}\n`);
        alertDiv.innerText = txt;
    }
    
    const warnDiv = document.getElementById('warningList');
    if (warnings.length === 0) {
        warnDiv.innerHTML = '<span style="color:#888;">Нет предупреждений</span>';
    } else {
        let txt = '';
        warnings.forEach(r => txt += `⚠️ ${r.name}\n`);
        warnDiv.innerText = txt;
    }
}

function selectRegion(idx) {
    if (selectedIdx !== null && regions[selectedIdx]) {
        const old = regions[selectedIdx];
        const colors = DANGER_COLORS[old.dangerLevel];
        old.layer.setStyle({ weight: 1.4, dashArray: '', color: colors.border, fillOpacity: 0.78 });
    }
    selectedIdx = idx;
    if (idx !== null && regions[idx]) {
        const cur = regions[idx];
        const colors = DANGER_COLORS[cur.dangerLevel];
        cur.layer.setStyle({ weight: 3, dashArray: '6,4', color: '#fff', fillOpacity: 0.94 });
        cur.layer.bringToFront();
        updateSelectedInfoUI();
        document.getElementById('selectedInfo').style.display = 'block';
    } else {
        document.getElementById('selectedInfo').style.display = 'none';
    }
}

function updateSelectedInfoUI() {
    if (selectedIdx !== null && regions[selectedIdx]) {
        const r = regions[selectedIdx];
        document.getElementById('selectedRegionName').innerHTML = r.name;
        document.getElementById('selectedRegionStatus').innerHTML = DANGER_COLORS[r.dangerLevel].name;
        const lastTimeStr = r.lastChanged ? r.lastChanged.toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit' }) : '—';
        document.getElementById('selectedRegionTime').innerHTML = `Изменён: ${lastTimeStr}`;
    }
}

function setLevelToSelected(level) {
    if (selectedIdx !== null) {
        const oldLevel = regions[selectedIdx].dangerLevel;
        regions[selectedIdx].dangerLevel = level;
        regions[selectedIdx].lastChanged = new Date();
        statusHistory.set(regions[selectedIdx].name, { 
            prevLevel: oldLevel, 
            newLevel: level, 
            changeTime: new Date() 
        });
        lastGlobalChange = new Date();
        updateRegionStyle(selectedIdx);
        updateSummaryUI();
        updateSelectedInfoUI();
        updateLastChangeBadge();
        renderRecentChanges();
        showToast(`📌 ${regions[selectedIdx].name}: ${DANGER_COLORS[level].name}`);
    } else {
        alert('Сначала выберите регион на карте');
    }
}

function clearAllAlerts() {
    if (confirm('Сбросить все тревоги?')) {
        regions.forEach((_, idx) => {
            if (regions[idx].dangerLevel !== 'clear') {
                regions[idx].dangerLevel = 'clear';
                regions[idx].lastChanged = new Date();
                updateRegionStyle(idx);
            }
        });
        lastGlobalChange = new Date();
        updateSummaryUI();
        if (selectedIdx !== null) updateSelectedInfoUI();
        updateLastChangeBadge();
        renderRecentChanges();
        showToast('✅ Все тревоги сброшены');
    }
}

// Названия на карте
function createStaticLabels() {
    const container = document.getElementById('regionLabelContainer');
    container.innerHTML = '';
    labelItems = [];
    const currentZoom = map.getZoom();
    const shouldHide = currentZoom < 4.8;
    
    regions.forEach(region => {
        try {
            const layer = region.layer;
            let center = layer.getBounds ? layer.getBounds().getCenter() : (layer.getLatLng ? layer.getLatLng() : null);
            if (!center) return;
            const point = map.latLngToContainerPoint(center);
            const div = document.createElement('div');
            div.className = 'region-label';
            if (shouldHide) div.classList.add('zoom-hidden');
            div.style.left = point.x + 'px';
            div.style.top = point.y + 'px';
            
            const [city, regionText] = getDisplayName(region.name);
            const citySpan = document.createElement('span');
            citySpan.className = 'region-label-city';
            citySpan.textContent = city;
            div.appendChild(citySpan);
            
            if (regionText && regionText !== city) {
                const regionSpan = document.createElement('span');
                regionSpan.className = 'region-label-region';
                regionSpan.textContent = regionText;
                div.appendChild(regionSpan);
            }
            
            container.appendChild(div);
            labelItems.push({ element: div, center: center });
        } catch(e) {}
    });
}

function updateLabelVisibility() {
    const currentZoom = map.getZoom();
    const shouldHide = currentZoom < 4.8;
    labelItems.forEach(item => {
        if (shouldHide) item.element.classList.add('zoom-hidden');
        else item.element.classList.remove('zoom-hidden');
    });
}

function updateLabelPositions() {
    for (let item of labelItems) {
        const pt = map.latLngToContainerPoint(item.center);
        item.element.style.left = pt.x + 'px';
        item.element.style.top = pt.y + 'px';
    }
}

map.on('zoomend', () => { createStaticLabels(); updateLabelVisibility(); });
map.on('move', () => updateLabelPositions());
map.on('click', () => selectRegion(null));

// UI обработчики
document.querySelectorAll('.danger-btn').forEach(btn => {
    btn.addEventListener('click', () => setLevelToSelected(btn.dataset.level));
});
document.getElementById('clearAllBtn').addEventListener('click', clearAllAlerts);
document.getElementById('refreshApiBtn').addEventListener('click', () => fetchApiAndUpdate());

document.getElementById('copyBtn').addEventListener('click', async () => {
    const rockets = regions.filter(r => r.dangerLevel === 'rocket');
    const drones = regions.filter(r => r.dangerLevel === 'drone');
    const warnings = regions.filter(r => r.dangerLevel === 'warning');
    const now = new Date();
    const msk = new Date(now.getTime() + 3*3600000 + now.getTimezoneOffset()*60000);
    let text = `СВОДКА ТРЕВОГ (МСК ${msk.toLocaleTimeString('ru-RU')})\n\n🔴 ТРЕВОГА:\n`;
    if (rockets.length+drones.length===0) text+='—\n';
    else { rockets.forEach(r=>text+=`🚀 ${r.name}\n`); drones.forEach(r=>text+=`✈️ ${r.name}\n`); }
    text+=`\n🟡 ОПАСНОСТЬ БПЛА:\n`;
    if (warnings.length===0) text+='—\n';
    else warnings.forEach(r=>text+=`⚠️ ${r.name}\n`);
    try {
        await navigator.clipboard.writeText(text);
        const btn=document.getElementById('copyBtn'); btn.textContent='✅ Скопировано!'; btn.classList.add('copied');
        setTimeout(()=>{btn.textContent='📋 Копировать сводку'; btn.classList.remove('copied');},1500);
    } catch(e) { alert('Копирование не удалось'); }
});

// Панель
const panel = document.getElementById('controlPanel');
const menuBtn = document.getElementById('menuBtn');
let panelOpen = false;
menuBtn.addEventListener('click', () => {
    panelOpen = !panelOpen;
    if (panelOpen) { 
        panel.classList.remove('hidden'); 
        menuBtn.classList.add('open'); 
        menuBtn.innerText = '✕'; 
        updateSummaryUI(); 
        renderRecentChanges(); 
    } else { 
        panel.classList.add('hidden'); 
        menuBtn.classList.remove('open'); 
        menuBtn.innerText = '#'; 
    }
});
document.addEventListener('keydown', (e) => { 
    if (e.key === 'h' || e.key === 'H') { 
        panelOpen = !panelOpen; 
        if(panelOpen) {
            panel.classList.remove('hidden'); 
            menuBtn.classList.add('open'); 
            menuBtn.innerText='✕';
            updateSummaryUI();
            renderRecentChanges();
        } else {
            panel.classList.add('hidden'); 
            menuBtn.classList.remove('open'); 
            menuBtn.innerText='#';
        }
    }
});

document.querySelectorAll('.tab-btn').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(t=>t.classList.remove('active'));
        tab.classList.add('active');
        document.querySelectorAll('.tab-content').forEach(c=>c.classList.remove('active'));
        document.getElementById(`tab${tab.dataset.tab.charAt(0).toUpperCase()+tab.dataset.tab.slice(1)}`).classList.add('active');
        if (tab.dataset.tab === 'summary') { updateSummaryUI(); renderRecentChanges(); }
    });
});

// Запуск
loadGeoJSON();
setInterval(() => fetchApiAndUpdate(), 60000);
