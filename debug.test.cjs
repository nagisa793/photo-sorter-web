const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, 'inline app script exists');
new vm.Script(script);

function extract(name) {
  const asyncStart = script.indexOf('async function ' + name + '(');
  const start = asyncStart >= 0 ? asyncStart : script.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' exists');
  let pos = script.indexOf('{', start), depth = 0;
  for (let i = pos; i < script.length; i++) {
    if (script[i] === '{') depth++;
    if (script[i] === '}' && --depth === 0) return script.slice(start, i + 1);
  }
  throw new Error('unclosed function ' + name);
}

test('selection sync updates all tiles and all trash rows without throwing', () => {
  const tiles = ['a', 'b'].map(id => ({dataset:{photoId:id},classList:{toggle(){},remove(){}}}));
  const rows = ['a', 'b'].map(id => ({dataset:{trashId:id},classList:{toggle(){}},querySelector:()=>({textContent:''})}));
  const content = {scrollTop:10,classList:{toggle(){}}};
  const gallery = {classList:{toggle(){}}};
  const area = {innerHTML:''};
  const context = {
    ui:{selected:true,arrange:false,ids:new Set(['a']),trashSelecting:true,trashIds:new Set(['b'])},
    $: selector => ({'#content':content,'#gallery':gallery,'#toolArea':area})[selector],
    $$: selector => selector.startsWith('#gallery') ? tiles : rows,
    regularSelectionToolbar:()=>'',trashSelectionToolbar:()=>'',header:()=>{},
  };
  vm.createContext(context);
  vm.runInContext(extract('syncRegularSelectionUI')+'\n'+extract('syncTrashSelectionUI'), context);
  assert.doesNotThrow(()=>context.syncRegularSelectionUI());
  assert.doesNotThrow(()=>context.syncTrashSelectionUI());
  assert.equal(content.scrollTop,10);
});

test('failed save does not advance state, undo or redo history', async () => {
  const context = {state:{count:1},history:[],future:[],render:()=>{},header:()=>{},toast:()=>{},console:{error(){}},txPut:async()=>{throw Error('quota')}};
  vm.createContext(context);
  vm.runInContext(extract('persist')+'\n'+extract('snapshot')+'\n'+extract('change')+'\n'+extract('changeWithoutRender')+'\n'+extract('undo')+'\n'+extract('redo'),context);
  await assert.rejects(context.change(()=>context.state.count++), /quota/);
  assert.equal(context.state.count,1);
  assert.equal(context.history.length,0);
  context.history.push('{"count":0}');
  await assert.rejects(context.undo(), /quota/);
  assert.equal(context.state.count,1);
  assert.equal(context.history.length,1);
  assert.equal(context.future.length,0);
});

test('existing 900 photo records keep their IDs and default order', () => {
  const photos = {}, allOrder = [];
  for (let i = 0; i < 900; i++) {
    const id = 'photo-' + i;
    photos[id] = {id,importAt:i + 1,showAll:true,hidden:false,deletedAt:null};
    allOrder.push(id);
  }
  const context = {
    state:{photos,allOrder,manualViewAll:null,sort:{all:'manual'}},
    ui:{tab:'all',page:null,group:null},
  };
  vm.createContext(context);
  vm.runInContext([
    extract('photo'),extract('available'),extract('manualNeedsReverse'),
    extract('manualOldestFirst'),extract('getSort'),extract('visibleIds'),
  ].join('\n'),context);
  const ids = context.visibleIds();
  assert.equal(ids.length,900);
  assert.equal(ids[0],'photo-0');
  assert.equal(ids[899],'photo-899');
  assert.equal(Object.keys(photos).length,900);
});
