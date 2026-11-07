import * as vscode from 'vscode';

const VIEW_TYPE = 'jsonlViewer.editor';
const MAX_FILE_BYTES = 128 * 1024 * 1024;

class JsonlFile implements vscode.CustomDocument {
	constructor(
		readonly uri: vscode.Uri,
		readonly lines: string[],
		readonly size: number,
		readonly tooLarge: boolean
	) {}

	dispose(): void {
		// Nothing to release: the lines live in memory until the document is closed.
	}
}

class JsonlEditorProvider implements vscode.CustomReadonlyEditorProvider<JsonlFile> {
	constructor(private readonly extensionUri: vscode.Uri) {}

	async openCustomDocument(uri: vscode.Uri): Promise<JsonlFile> {
		const size = (await vscode.workspace.fs.stat(uri)).size;
		if (size > MAX_FILE_BYTES) {
			return new JsonlFile(uri, [], size, true);
		}
		return new JsonlFile(uri, await readLines(uri), size, false);
	}

	async resolveCustomEditor(document: JsonlFile, panel: vscode.WebviewPanel): Promise<void> {
		const webview = panel.webview;
		webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
		};
		webview.html = getHtml(webview, this.extensionUri);

		const subscription = webview.onDidReceiveMessage((message: { type?: string }) => {
			switch (message?.type) {
				case 'ready':
					void webview.postMessage(document.tooLarge
						? { type: 'tooLarge', name: baseName(document.uri), sizeLabel: formatSize(document.size), limitLabel: formatSize(MAX_FILE_BYTES) }
						: { type: 'init', name: baseName(document.uri), lines: document.lines });
					break;
				case 'openAsText':
					void vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
					break;
			}
		});
		panel.onDidDispose(() => subscription.dispose());
	}
}

async function readLines(uri: vscode.Uri): Promise<string[]> {
	const bytes = await vscode.workspace.fs.readFile(uri);
	const text = new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '');
	const lines = text.split(/\r?\n/);
	if (lines.length > 0 && lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines;
}

function formatSize(bytes: number): string {
	const megabytes = bytes / (1024 * 1024);
	return megabytes >= 1024 ? (megabytes / 1024).toFixed(1) + ' GB' : megabytes.toFixed(1) + ' MB';
}

function baseName(uri: vscode.Uri): string {
	const index = uri.path.lastIndexOf('/');
	return index >= 0 ? uri.path.slice(index + 1) : uri.path;
}

function activeResource(): vscode.Uri | undefined {
	const editor = vscode.window.activeTextEditor;
	if (editor) {
		return editor.document.uri;
	}
	const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
	if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) {
		return input.uri;
	}
	return undefined;
}

function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const nonce = getNonce();
	const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'style.css'));
	const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.js'));
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${styleUri}">
<title>JSONL Viewer</title>
</head>
<body>
<div id="header">
	<span id="name"></span>
	<span id="count">loading…</span>
	<button id="open-text" type="button" title="Open this file with the text editor">Open as Text</button>
</div>
<div id="viewport" tabindex="0"><div id="layer"></div></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let nonce = '';
	for (let i = 0; i < 32; i++) {
		nonce += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return nonce;
}

export function activate(context: vscode.ExtensionContext): void {
	const provider = new JsonlEditorProvider(context.extensionUri);
	context.subscriptions.push(
		vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
			webviewOptions: { retainContextWhenHidden: true },
			supportsMultipleEditorsPerDocument: false
		}),
		vscode.commands.registerCommand('jsonlViewer.open', async (resource?: vscode.Uri) => {
			const uri = resource ?? activeResource();
			if (!uri) {
				void vscode.window.showErrorMessage('No JSONL file is selected.');
				return;
			}
			await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
		})
	);
}

export function deactivate(): void {
	// No global state to release.
}
