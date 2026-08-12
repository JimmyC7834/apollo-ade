import assert from 'node:assert/strict';

import { Peer } from './jsonrpc.ts';

function harness() {
	const sent: Record<string, unknown>[] = [];
	const notifications: [string, unknown][] = [];
	const peer = new Peer(
		(body) => sent.push(JSON.parse(body) as Record<string, unknown>),
		(method, params) => notifications.push([method, params])
	);
	return { peer, sent, notifications };
}

{
	const { peer, sent } = harness();
	const first = peer.request('textDocument/definition', { line: 1 });
	const second = peer.request('textDocument/hover');

	assert.equal(sent.length, 2);
	assert.equal(sent[0]?.jsonrpc, '2.0');
	assert.equal(sent[0]?.method, 'textDocument/definition');
	assert.notEqual(sent[0]?.id, sent[1]?.id, 'two requests must not share an id');

	// Answered out of order, which is normal: hover is fast and definition is
	// not. Correlation by id is the whole point.
	peer.receive(JSON.stringify({ jsonrpc: '2.0', id: sent[1]?.id, result: 'hovered' }));
	peer.receive(JSON.stringify({ jsonrpc: '2.0', id: sent[0]?.id, result: 'defined' }));

	assert.equal(await second, 'hovered');
	assert.equal(await first, 'defined');
}

{
	const { peer, sent } = harness();
	const pending = peer.request('textDocument/rename');
	peer.receive(
		JSON.stringify({ jsonrpc: '2.0', id: sent[0]?.id, error: { code: -32603, message: 'cannot rename this' } })
	);
	await assert.rejects(pending, /cannot rename this/);
}

{
	const { peer, notifications } = harness();
	peer.notify('initialized', {});
	// A notification carries no id, so nothing is ever waiting for it.
	peer.receive(JSON.stringify({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'x' } }));
	assert.deepEqual(notifications, [['textDocument/publishDiagnostics', { uri: 'x' }]]);
}

{
	// A server-to-client *request* has both a method and an id. Routing it as a
	// reply would settle somebody else's promise with the wrong value.
	const { peer, sent, notifications } = harness();
	const pending = peer.request('textDocument/definition');
	peer.receive(JSON.stringify({ jsonrpc: '2.0', id: sent[0]?.id, method: 'window/workDoneProgress/create' }));
	assert.equal(notifications.length, 1);

	peer.receive(JSON.stringify({ jsonrpc: '2.0', id: sent[0]?.id, result: null }));
	assert.equal(await pending, null, 'the real reply still lands');
}

{
	const { peer, sent } = harness();
	const pending = peer.request('textDocument/definition');

	// Garbage in must not throw out of the event handler that delivers it.
	peer.receive('not json');
	peer.receive('null');
	peer.receive(JSON.stringify({ jsonrpc: '2.0', id: 9999, result: 'someone else' }));

	// A reply delivered twice must not settle a promise that is no longer there.
	peer.receive(JSON.stringify({ jsonrpc: '2.0', id: sent[0]?.id, result: 'once' }));
	peer.receive(JSON.stringify({ jsonrpc: '2.0', id: sent[0]?.id, result: 'twice' }));
	assert.equal(await pending, 'once');
}

{
	// The crash case. An unsettled request is a click that does nothing forever.
	const { peer, sent } = harness();
	const pending = peer.request('textDocument/references');
	peer.fail('the language server stopped');
	await assert.rejects(pending, /stopped/);

	await assert.rejects(peer.request('textDocument/hover'), /not running/);
	peer.notify('exit');
	assert.equal(sent.length, 1, 'nothing is written to a dead peer');
}

console.log('jsonrpc.check.ts ok');
