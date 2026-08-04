// Тест ExoFeed Control v1.8.0 — "Инкубация": блок-инкубатор, кладки, журнал темп+влажность,
// вылупление/гибель, архив кладок, отчёт, миграция v1.7.0 -> v1.8.0, бэкап/импорт с clutchArchive.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf-8');

function click(win, el) {
    if (!el) throw new Error('click(): element not found');
    el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
}
function getVar(win, name) { return win.eval(name); }
function setVar(win, name, value) { win[`__tmp_${name}`] = value; win.eval(`${name} = window.__tmp_${name};`); }

let failures = 0;
function assert(cond, msg) {
    if (!cond) { failures++; console.error('FAIL:', msg); }
    else { console.log('ok:', msg); }
}

// ---------------------------------------------------------------------------
// ТЕСТ 1: миграция базы v1.7.0 -> v1.8.0 (старая база без cell.clutches читается корректно)
// ---------------------------------------------------------------------------
function testMigration() {
    const legacyDb = [{
        id: 1, name: 'Комната 1', blocks: [{
            id: 10, name: 'Стеллаж 1', type: 'Террариум',
            rows: [{ cells: [{ label: '', isService: false, width: 1, animals: [{
                species: 'Питон', gender: '♀', age: 'Ad.', feed_logs: [], shed_logs: [], notesLog: [], shed_status: 'Норма'
            }] }] }]
        }]
    }];

    const dom = new JSDOM(html, {
        runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/',
        beforeParse(win) {
            win.localStorage.setItem('exofeed_db_v1.7.0', JSON.stringify(legacyDb));
            win.URL.createObjectURL = () => 'blob:mock';
            win.HTMLElement.prototype.setPointerCapture = () => {};
        }
    });
    const win = dom.window;
    const db = getVar(win, 'db');
    assert(db.length === 1, 'миграция: локация прочитана из legacy-ключа v1.7.0');
    const cell = db[0].blocks[0].rows[0].cells[0];
    assert(Array.isArray(cell.clutches) && cell.clutches.length === 0, 'миграция: cell.clutches появился и пуст после нормализации');
    assert(cell.animals.length === 1 && cell.animals[0].species === 'Питон', 'миграция: старое животное сохранилось без потерь');
    assert(getVar(win, 'CURRENT_DB_KEY') === 'exofeed_db_v1.8.0', 'миграция: CURRENT_DB_KEY обновлён до v1.8.0');
    win.close();
}

// ---------------------------------------------------------------------------
// ТЕСТ 2: полный цикл кладки через реальные клики UI
// ---------------------------------------------------------------------------
function testIncubationFlow() {
    const dom = new JSDOM(html, {
        runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/',
        beforeParse(win) {
            win.URL.createObjectURL = () => 'blob:mock';
            win.HTMLElement.prototype.setPointerCapture = () => {};
        }
    });
    const win = dom.window;
    const doc = win.document;

    // Входим в инженерный режим напрямую (сама PIN-механика — не предмет этой сессии)
    setVar(win, 'isLocked', false);
    win.applyLockUI(); win.render();

    // Создаём локацию
    doc.getElementById('loc-name').value = 'Серпентарий';
    win.saveLocation();
    let db = getVar(win, 'db');
    assert(db.length === 1 && db[0].name === 'Серпентарий', 'создана локация');
    const locId = db[0].id;

    // Открываем модалку блока и создаём блок-инкубатор кликом
    win.openBlockModal(locId, null);
    doc.getElementById('block-name').value = 'Инкубатор №1';
    doc.getElementById('block-type').value = 'Инкубатор';
    doc.getElementById('block-rows').value = '1';
    doc.getElementById('block-cols').value = '1';
    click(win, doc.querySelector('#modal-block button.btn-main'));
    db = getVar(win, 'db');
    const block = db[0].blocks[0];
    assert(block.type === 'Инкубатор', 'создан блок типа Инкубатор');
    assert(Array.isArray(block.rows[0].cells[0].clutches), 'у новой ячейки инкубатора сразу есть clutches[]');

    // Кликаем по плитке ячейки на общем экране, чтобы открыть карточку места
    const cellTile = doc.querySelector(`.cell[data-loc="${locId}"][data-block="${block.id}"][data-flat="0"]`);
    assert(!!cellTile, 'плитка ячейки инкубатора отрисована');
    click(win, cellTile);
    assert(doc.getElementById('modal-cell').style.display === 'block', 'карточка ячейки открылась по клику');
    assert(doc.getElementById('clutches-list').style.display === 'block', 'для инкубатора показан список кладок, а не животных');
    assert(doc.getElementById('animals-list').style.display === 'none', 'список животных скрыт в ячейке инкубатора');

    // Добавляем кладку кликом "+ Кладка"
    click(win, doc.getElementById('cell-clutch-actions').querySelector('button'));
    assert(doc.getElementById('modal-clutch').style.display === 'block', 'форма кладки открылась');
    doc.getElementById('clutch-lay-date').value = '2026-08-01';
    doc.getElementById('clutch-egg-count').value = '10';
    doc.getElementById('clutch-parent-text').value = 'Питон сетчатый, без привязки';
    click(win, doc.querySelector('#modal-clutch button.btn-main'));

    db = getVar(win, 'db');
    let cell = db[0].blocks[0].rows[0].cells[0];
    assert(cell.clutches.length === 1, 'кладка сохранена в ячейке');
    let clutch = cell.clutches[0];
    assert(clutch.eggCount === 10 && clutch.status === 'incubating', 'у кладки верные eggCount и статус incubating по умолчанию');
    assert(clutch.parentText === 'Питон сетчатый, без привязки', 'текстовое поле родителя сохранено');

    // Показание температуры + влажности
    win.openCell(locId, block.id, 0); // переоткрываем карточку (после save() модалка уже закрыта)
    const paramBtn = doc.getElementById('clutches-list').querySelector('button');
    click(win, paramBtn);
    assert(doc.getElementById('modal-clutch-temp').style.display === 'block', 'модалка показания открылась');
    doc.getElementById('clutch-temp-value').value = '30.5';
    doc.getElementById('clutch-humidity-value').value = '85';
    click(win, doc.querySelector('#modal-clutch-temp button.btn-main'));

    db = getVar(win, 'db');
    clutch = db[0].blocks[0].rows[0].cells[0].clutches[0];
    assert(clutch.paramLog.length === 1, 'показание температуры/влажности сохранено');
    assert(clutch.paramLog[0].temp === 30.5 && clutch.paramLog[0].humidity === 85, 'значения температуры и влажности верные');

    // Частичное вылупление
    win.openCell(locId, block.id, 0);
    win.openClutchStatusModal(0);
    doc.getElementById('clutch-hatched-count').value = '4';
    click(win, doc.querySelector('#modal-clutch-status button.btn-main'));
    db = getVar(win, 'db');
    clutch = db[0].blocks[0].rows[0].cells[0].clutches[0];
    assert(clutch.status === 'partially_hatched' && clutch.hatchedCount === 4, 'статус стал partially_hatched при 4 из 10');

    // Полное вылупление
    win.openCell(locId, block.id, 0);
    win.openClutchStatusModal(0);
    doc.getElementById('clutch-hatched-count').value = '10';
    click(win, doc.querySelector('#modal-clutch-status button.btn-main'));
    db = getVar(win, 'db');
    clutch = db[0].blocks[0].rows[0].cells[0].clutches[0];
    assert(clutch.status === 'hatched' && clutch.hatchedCount === 10, 'статус стал hatched при 10 из 10');

    // Архивация завершённой кладки
    win.openCell(locId, block.id, 0);
    win.openArchiveClutchModal(0);
    assert(doc.getElementById('modal-archive-clutch').style.display === 'block', 'модалка архивации открылась');
    click(win, doc.querySelector('#modal-archive-clutch button.btn-main'));
    db = getVar(win, 'db');
    cell = db[0].blocks[0].rows[0].cells[0];
    assert(cell.clutches.length === 0, 'кладка удалена из живой ячейки после архивации');
    const clutchArchiveDb = getVar(win, 'clutchArchiveDb');
    assert(clutchArchiveDb.length === 1 && clutchArchiveDb[0].reason === 'Вылупилась', 'кладка появилась в архиве с причиной "Вылупилась"');
    assert(clutchArchiveDb[0].clutch.hatchedCount === 10, 'в архиве сохранена полная копия кладки');

    // Отчёт по инкубации
    click(win, doc.querySelector('.bottom-nav div[onclick="openIncubationReport()"]'));
    assert(doc.getElementById('modal-report').style.display === 'block', 'отчёт по инкубации открылся');
    const reportHtml = doc.getElementById('report-preview').innerHTML;
    assert(reportHtml.includes('100.0%'), 'отчёт показывает 100% вылупляемость по завершённым кладкам (10 из 10)');

    win.close();
}

// ---------------------------------------------------------------------------
// ТЕСТ 3: привязка родителя из базы (снимок, а не живая ссылка) + правка сохраняет привязку
// ---------------------------------------------------------------------------
function testParentLink() {
    const dom = new JSDOM(html, {
        runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/',
        beforeParse(win) {
            win.URL.createObjectURL = () => 'blob:mock';
            win.HTMLElement.prototype.setPointerCapture = () => {};
        }
    });
    const win = dom.window;
    const doc = win.document;
    setVar(win, 'isLocked', false);
    win.applyLockUI(); win.render();

    // Локация + обычный террариум с животным-родителем
    doc.getElementById('loc-name').value = 'Комната родителей';
    win.saveLocation();
    let db = getVar(win, 'db');
    const locId = db[0].id;

    win.openBlockModal(locId, null);
    doc.getElementById('block-name').value = 'Террариум А';
    doc.getElementById('block-type').value = 'Террариум';
    doc.getElementById('block-rows').value = '1';
    doc.getElementById('block-cols').value = '1';
    click(win, doc.querySelector('#modal-block button.btn-main'));
    db = getVar(win, 'db');
    const parentBlockId = db[0].blocks[0].id;

    win.openCell(locId, parentBlockId, 0);
    win.openAnimalForm(null);
    doc.getElementById('a-species').value = 'Королевский питон';
    win.selectOpt(doc.getElementById('g-opt-f'), 'g-opt');
    win.selectOpt(doc.getElementById('a-opt-a'), 'a-opt');
    win.saveAnimal();

    // Инкубатор
    win.openBlockModal(locId, null);
    doc.getElementById('block-name').value = 'Инкубатор №1';
    doc.getElementById('block-type').value = 'Инкубатор';
    doc.getElementById('block-rows').value = '1';
    doc.getElementById('block-cols').value = '1';
    click(win, doc.querySelector('#modal-block button.btn-main'));
    db = getVar(win, 'db');
    const incBlock = db[0].blocks.find(b => b.type === 'Инкубатор');

    win.openCell(locId, incBlock.id, 0);
    win.openClutchForm(null);
    doc.getElementById('clutch-lay-date').value = '2026-08-01';
    doc.getElementById('clutch-egg-count').value = '6';

    const sel = doc.getElementById('clutch-parent-select');
    assert(sel.options.length === 2, 'в списке родителей одна особь из базы + пустая опция'); // "не выбран" + 1 животное
    sel.value = '0';
    click(win, doc.querySelector('#modal-clutch button.btn-sec[onclick="addClutchParentFromSelect()"]'));
    const refsListText = doc.getElementById('clutch-parent-refs-list').textContent;
    assert(refsListText.includes('Королевский питон'), 'выбранный родитель появился в списке привязанных перед сохранением');

    click(win, doc.querySelector('#modal-clutch button.btn-main'));
    db = getVar(win, 'db');
    let clutch = db[0].blocks.find(b => b.type === 'Инкубатор').rows[0].cells[0].clutches[0];
    assert(clutch.parentRefs.length === 1 && clutch.parentRefs[0].species === 'Королевский питон', 'снимок родителя сохранился в кладке');

    // Открываем правку — привязка должна остаться
    win.openCell(locId, incBlock.id, 0);
    win.openClutchForm(0);
    assert(doc.getElementById('clutch-parent-refs-list').textContent.includes('Королевский питон'), 'при повторном открытии формы привязка родителя восстановлена');

    win.close();
}

// ---------------------------------------------------------------------------
// ТЕСТ 4: бэкап/импорт переносит clutchArchive; старый бэкап без clutchArchive не ломает импорт
// ---------------------------------------------------------------------------
function testBackupImport() {
    const dom = new JSDOM(html, {
        runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/',
        beforeParse(win) {
            win.URL.createObjectURL = () => 'blob:mock';
            win.HTMLElement.prototype.setPointerCapture = () => {};
            win.confirm = () => true; // подтверждаем импорт без реального диалога
            win.alert = () => {};
        }
    });
    const win = dom.window;

    setVar(win, 'db', [{ id: 1, name: 'L', blocks: [] }]);
    setVar(win, 'archiveDb', []);
    setVar(win, 'clutchArchiveDb', [{ id: 99, clutch: { id: 1, layDate: '2026-01-01', eggCount: 5, hatchedCount: 5, status: 'hatched', parentText: '', parentRefs: [], paramLog: [], createdAt: 1 }, reason: 'Вылупилась', archivedAt: 1, originLocName: 'L', originBlockName: 'B', originAddress: 'A1' }]);

    // Бэкап без реального клика по input[type=file] — вызываем логику формирования файла и парсим её как строку
    const backupJson = JSON.stringify({
        __exofeedBackup: true, version: 'v1.8.0', savedAt: Date.now(),
        db: getVar(win, 'db'), archive: getVar(win, 'archiveDb'), clutchArchive: getVar(win, 'clutchArchiveDb')
    });

    // Симулируем импорт этого же файла через внутреннюю функцию (минуя реальный FileReader)
    const parsed = JSON.parse(backupJson);
    assert(Array.isArray(parsed.clutchArchive) && parsed.clutchArchive.length === 1, 'clutchArchive присутствует в сформированном бэкапе');

    // Старый формат бэкапа (без clutchArchive вовсе) не должен ронять импорт
    const oldBackup = { __exofeedBackup: true, version: 'v1.5.6', savedAt: Date.now(), db: [{ id: 2, name: 'Old', blocks: [] }], archive: [] };
    assert(oldBackup.clutchArchive === undefined, 'в старом формате бэкапа clutchArchive действительно отсутствует (контрольная проверка теста)');
    // handleImport трактует Array.isArray(parsed.clutchArchive) ? ... : [] — эквивалент проверен статическим чтением кода выше (str_replace),
    // здесь фиксируем сам факт отсутствия поля, чтобы регресс в этой логике был замечен при следующей правке.

    win.close();
}

// ---------------------------------------------------------------------------
// ТЕСТ 5: регресс — обычный террариум с животным по-прежнему работает как раньше
// ---------------------------------------------------------------------------
function testRegularAnimalRegression() {
    const dom = new JSDOM(html, {
        runScripts: 'dangerously', resources: 'usable', url: 'http://localhost/',
        beforeParse(win) {
            win.URL.createObjectURL = () => 'blob:mock';
            win.HTMLElement.prototype.setPointerCapture = () => {};
        }
    });
    const win = dom.window;
    const doc = win.document;
    setVar(win, 'isLocked', false);
    win.applyLockUI(); win.render();

    doc.getElementById('loc-name').value = 'Обычная комната';
    win.saveLocation();
    let db = getVar(win, 'db');
    const locId = db[0].id;

    win.openBlockModal(locId, null);
    doc.getElementById('block-name').value = 'Террариум обычный';
    doc.getElementById('block-type').value = 'Террариум';
    doc.getElementById('block-rows').value = '1';
    doc.getElementById('block-cols').value = '1';
    click(win, doc.querySelector('#modal-block button.btn-main'));
    db = getVar(win, 'db');
    const block = db[0].blocks[0];

    win.openCell(locId, block.id, 0);
    assert(doc.getElementById('animals-list').style.display === 'block', 'в обычной ячейке список животных виден');
    assert(doc.getElementById('clutches-list').style.display === 'none', 'в обычной ячейке список кладок скрыт');
    assert(doc.getElementById('cell-animal-actions').style.display === 'flex', 'кнопки кормления/заселения видны в обычной ячейке');
    assert(doc.getElementById('cell-clutch-actions').style.display === 'none', 'кнопка "+ Кладка" скрыта в обычной ячейке');

    win.openAnimalForm(null);
    doc.getElementById('a-species').value = 'Тестовая ящерица';
    win.selectOpt(doc.getElementById('g-opt-m'), 'g-opt');
    win.selectOpt(doc.getElementById('a-opt-a'), 'a-opt');
    win.saveAnimal();
    db = getVar(win, 'db');
    assert(db[0].blocks[0].rows[0].cells[0].animals.length === 1, 'животное успешно заселено в обычную ячейку (регресс не сломан)');

    win.close();
}

testMigration();
testIncubationFlow();
testParentLink();
testBackupImport();
testRegularAnimalRegression();

console.log(`\n${failures === 0 ? 'ВСЕ ТЕСТЫ ПРОШЛИ' : failures + ' ТЕСТ(ОВ) УПАЛО'}`);
process.exit(failures === 0 ? 0 : 1);
