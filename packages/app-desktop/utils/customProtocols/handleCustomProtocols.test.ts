/** @jest-environment node */

type ProtocolHandler = (request: Request)=> Promise<Response>;
const customProtocols: Map<string, ProtocolHandler> = new Map();

const handleProtocolMock = jest.fn((scheme: string, handler: ProtocolHandler) => {
	customProtocols.set(scheme, handler);
});
const fetchMock = jest.fn(async url => new Response(`Mock response to ${url}`));

jest.doMock('electron', () => {
	return {
		net: {
			fetch: fetchMock,
		},
		protocol: {
			handle: handleProtocolMock,
		},
	};
});

import Logger from '@joplin/utils/Logger';
import handleCustomProtocols from './handleCustomProtocols';
import { supportDir } from '@joplin/lib/testing/test-utils';
import { join } from 'path';
import { stat } from 'fs-extra';
import { toForwardSlashes } from '@joplin/utils/path';

const setUpProtocolHandler = () => {
	const logger = Logger.create('test-logger');
	const protocolHandler = handleCustomProtocols(logger);

	expect(handleProtocolMock).toHaveBeenCalledTimes(1);

	// Should have registered the protocol.
	const lastCallArgs = handleProtocolMock.mock.lastCall;
	expect(lastCallArgs[0]).toBe('joplin-content');

	// Extract the request listener so that it can be called by our tests.
	const onRequestListener = lastCallArgs[1];

	return { protocolHandler, onRequestListener };
};

const expectPathToBeBlocked = async (onRequestListener: ProtocolHandler, filePath: string) => {
	const url = `joplin-content://note-viewer/${filePath}`;

	await expect(
		async () => await onRequestListener(new Request(url)),
	).rejects.toThrowError('Read access not granted for URL');
};

const expectPathToBeUnblocked = async (onRequestListener: ProtocolHandler, filePath: string) => {
	const handleRequestResult = await onRequestListener(new Request(`joplin-content://note-viewer/${filePath}`));
	expect(handleRequestResult.body).toBeTruthy();
};


describe('handleCustomProtocols', () => {
	beforeEach(() => {
		// Reset mocks between tests to ensure a clean testing environment.
		customProtocols.clear();
		handleProtocolMock.mockClear();
		fetchMock.mockClear();
	});

	test('should only allow access to files in allowed directories', async () => {
		const { protocolHandler, onRequestListener } = setUpProtocolHandler();

		await expectPathToBeBlocked(onRequestListener, '/test/path');
		await expectPathToBeBlocked(onRequestListener, '/');

		protocolHandler.allowReadAccessToDirectory('/test/path/');
		await expectPathToBeUnblocked(onRequestListener, '/test/path');
		await expectPathToBeUnblocked(onRequestListener, '/test/path/a.txt');
		await expectPathToBeUnblocked(onRequestListener, '/test/path/b.txt');

		await expectPathToBeBlocked(onRequestListener, '/');
		await expectPathToBeBlocked(onRequestListener, '/test/path2');
		await expectPathToBeBlocked(onRequestListener, '/test/path/../a.txt');

		protocolHandler.allowReadAccessToDirectory('/another/path/here');

		await expectPathToBeBlocked(onRequestListener, '/another/path/here2');
		await expectPathToBeUnblocked(onRequestListener, '/another/path/here');
		await expectPathToBeUnblocked(onRequestListener, '/another/path/here/2');
	});

	test('should be possible to allow and remove read access for a file', async () => {
		const { protocolHandler, onRequestListener } = setUpProtocolHandler();
		await expectPathToBeBlocked(onRequestListener, '/test/path/a.txt');

		const handle1 = protocolHandler.allowReadAccessToFile('/test/path/a.txt');
		await expectPathToBeUnblocked(onRequestListener, '/test/path/a.txt');
		const handle2 = protocolHandler.allowReadAccessToFile('/test/path/a.txt');
		await expectPathToBeUnblocked(onRequestListener, '/test/path/a.txt');
		handle1.remove();
		await expectPathToBeUnblocked(onRequestListener, '/test/path/a.txt');
		handle2.remove();

		await expectPathToBeBlocked(onRequestListener, '/test/path/a.txt');
	});

	test('should allow requesting part of a file', async () => {
		const { protocolHandler, onRequestListener } = setUpProtocolHandler();

		protocolHandler.allowReadAccessToDirectory(`${supportDir}/`);
		const targetFilePath = join(supportDir, 'photo.jpg');
		const targetUrl = `joplin-content://note-viewer/${toForwardSlashes(targetFilePath)}`;

		// Should return correct headers for an in-range response,
		let response = await onRequestListener(new Request(
			targetUrl,
			{ headers: { 'Range': 'bytes=10-20' } },
		));

		expect(response.status).toBe(206); // Partial content
		expect(response.headers.get('Accept-Ranges')).toBe('bytes');
		expect(response.headers.get('Content-Type')).toBe('image/jpeg');
		expect(response.headers.get('Content-Length')).toBe('11');
		const targetStats = await stat(targetFilePath);
		expect(response.headers.get('Content-Range')).toBe(`bytes 10-20/${targetStats.size}`);

		// Should return correct headers for an out-of-range response,
		response = await onRequestListener(new Request(
			targetUrl,
			{ headers: { 'Range': 'bytes=99999999999999-999999999999990' } },
		));
		expect(response.status).toBe(416); // Out of range
	});
});