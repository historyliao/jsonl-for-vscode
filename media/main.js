(function () {
	const vscode = acquireVsCodeApi();

	const OVERSCAN = 8;

	const headerName = document.getElementById('name');
	const headerCount = document.getElementById('count');
	const viewport = document.getElementById('viewport');
	const layer = document.getElementById('layer');

	const fontSize = parseFloat(getComputedStyle(document.body).fontSize) || 13;
	const ROW_H = Math.max(20, Math.round(fontSize * 1.65));
	document.documentElement.style.setProperty('--row-height', ROW_H + 'px');

	document.getElementById('open-text').addEventListener('click', () => {
		vscode.postMessage({ type: 'openAsText' });
	});

	let lines = [];
	let heights = new Float64Array(0);
	let tops = new Float64Array(0);
	const expanded = new Set();
	const prettyCache = new Map();
	const rows = new Map();

	window.addEventListener('message', (event) => {
		const message = event.data;
		if (!message) {
			return;
		}
		if (message.type === 'init') {
			headerName.textContent = message.name;
			setLines(message.lines);
		} else if (message.type === 'tooLarge') {
			headerName.textContent = message.name;
			headerCount.textContent = message.sizeLabel;
			showNotice('This file is ' + message.sizeLabel + ', above the ' + message.limitLabel + ' viewer limit. Use “Open as Text” to open it in the text editor.');
		}
	});

	vscode.postMessage({ type: 'ready' });

	function setLines(nextLines) {
		lines = nextLines;
		const total = lines.length;
		heights = new Float64Array(total).fill(ROW_H);
		tops = new Float64Array(total);
		expanded.clear();
		prettyCache.clear();
		for (const element of rows.values()) {
			element.remove();
		}
		rows.clear();
		document.documentElement.style.setProperty('--digits', String(Math.max(3, String(total).length)));
		headerCount.textContent = total + ' lines';
		layout();
		viewport.scrollTop = 0;
		render();
	}

	function showNotice(text) {
		const notice = document.createElement('div');
		notice.className = 'notice';
		notice.textContent = text;
		viewport.append(notice);
	}

	function layout() {
		let offset = 0;
		for (let i = 0; i < heights.length; i++) {
			tops[i] = offset;
			offset += heights[i];
		}
		layer.style.height = offset + 'px';
	}

	function visibleRange() {
		const top = viewport.scrollTop;
		const bottom = top + viewport.clientHeight;
		let low = 0;
		let high = tops.length - 1;
		let start = tops.length;
		while (low <= high) {
			const mid = (low + high) >> 1;
			if (tops[mid] + heights[mid] > top) {
				start = mid;
				high = mid - 1;
			} else {
				low = mid + 1;
			}
		}
		let end = start;
		while (end < tops.length && tops[end] < bottom) {
			end++;
		}
		return { start: start, end: end };
	}

	function render() {
		const range = visibleRange();
		const from = Math.max(0, range.start - OVERSCAN);
		const to = Math.min(lines.length, range.end + OVERSCAN);
		const keep = new Set();
		let relayout = false;
		for (let i = from; i < to; i++) {
			keep.add(i);
			let element = rows.get(i);
			if (!element) {
				element = createRow(i);
				insertRow(i, element);
				rows.set(i, element);
				if (expanded.has(i)) {
					const measured = element.offsetHeight;
					if (measured > 0 && Math.abs(measured - heights[i]) > 0.5) {
						heights[i] = measured;
						relayout = true;
					}
				}
			}
			element.style.transform = 'translateY(' + tops[i] + 'px)';
		}
		for (const [index, element] of rows) {
			if (!keep.has(index)) {
				element.remove();
				rows.delete(index);
			}
		}
		if (relayout) {
			layout();
			for (const [index, element] of rows) {
				element.style.transform = 'translateY(' + tops[index] + 'px)';
			}
		}
	}

	// Keep DOM order identical to line order so drag-select and copy stay correct.
	function insertRow(index, element) {
		let next = -1;
		for (const other of rows.keys()) {
			if (other > index && (next === -1 || other < next)) {
				next = other;
			}
		}
		layer.insertBefore(element, next === -1 ? null : rows.get(next));
	}

	function toggleLine(index) {
		if (expanded.has(index)) {
			expanded.delete(index);
		} else {
			expanded.add(index);
		}
		const element = rows.get(index);
		if (element) {
			element.remove();
			rows.delete(index);
		}
		heights[index] = ROW_H;
		layout();
		render();
	}

	function createRow(index) {
		const isExpanded = expanded.has(index);
		const raw = lines[index];
		const element = document.createElement('div');
		element.className = 'row ' + (isExpanded ? 'expanded' : 'collapsed');

		const gutter = document.createElement('div');
		gutter.className = 'gutter';

		const toggle = document.createElement('button');
		toggle.type = 'button';
		toggle.className = 'toggle';
		toggle.textContent = isExpanded ? '\u2212' : '+';
		toggle.title = isExpanded ? 'Collapse' : 'Expand';
		toggle.setAttribute('aria-label', (isExpanded ? 'Collapse' : 'Expand') + ' line ' + (index + 1));
		toggle.setAttribute('aria-expanded', String(isExpanded));
		toggle.disabled = raw.trim() === '';
		toggle.addEventListener('click', (event) => {
			event.stopPropagation();
			toggleLine(index);
		});

		const lineNumber = document.createElement('span');
		lineNumber.className = 'ln';
		lineNumber.textContent = String(index + 1);

		gutter.append(toggle, lineNumber);

		const body = document.createElement('div');
		body.className = 'body';
		if (isExpanded) {
			const result = pretty(index);
			if (result.ok) {
				const pre = document.createElement('pre');
				pre.className = 'pretty';
				pre.append(highlight(result.text));
				body.append(pre);
			} else {
				const error = document.createElement('pre');
				error.className = 'pretty error';
				error.textContent = result.text;
				const rawLine = document.createElement('pre');
				rawLine.className = 'pretty raw';
				rawLine.textContent = raw;
				body.append(error, rawLine);
			}
		} else {
			const text = document.createElement('span');
			text.className = 'raw';
			text.textContent = raw;
			text.title = raw.length > 500 ? raw.slice(0, 500) + '…' : raw;
			body.append(text);
		}

		element.append(gutter, body);
		return element;
	}

	function pretty(index) {
		let cached = prettyCache.get(index);
		if (cached) {
			return cached;
		}
		const raw = lines[index];
		try {
			JSON.parse(raw);
			cached = { ok: true, text: reformat(raw) };
		} catch (error) {
			cached = { ok: false, text: 'Invalid JSON: ' + (error && error.message ? error.message : String(error)) };
		}
		prettyCache.set(index, cached);
		return cached;
	}

	const MAX_INDENT = 40;

	// Re-indents the original text instead of re-serializing it, so number literals,
	// big integers, duplicate keys and escapes are shown exactly as they appear in the file.
	function reformat(raw) {
		const lines = [];
		let line = '';
		let depth = 0;
		let inString = false;
		let escaped = false;

		function newline() {
			lines.push(line);
			line = '  '.repeat(Math.min(depth, MAX_INDENT));
		}

		for (let i = 0; i < raw.length; i++) {
			const ch = raw[i];

			if (inString) {
				line += ch;
				if (escaped) {
					escaped = false;
				} else if (ch === '\\') {
					escaped = true;
				} else if (ch === '"') {
					inString = false;
				}
				continue;
			}

			switch (ch) {
				case '"':
					inString = true;
					line += ch;
					break;
				case '{':
				case '[':
					line += ch;
					if (nextMeaningful(raw, i + 1) !== (ch === '{' ? '}' : ']')) {
						depth++;
						newline();
					}
					break;
				case '}':
				case ']':
					if (previousMeaningful(raw, i - 1) === (ch === '}' ? '{' : '[')) {
						line += ch;
					} else {
						depth--;
						newline();
						line += ch;
					}
					break;
				case ',':
					line += ch;
					newline();
					break;
				case ':':
					line += ': ';
					break;
				case ' ':
				case '\t':
				case '\r':
				case '\n':
					break;
				default:
					line += ch;
			}
		}

		if (line.trim() !== '') {
			lines.push(line);
		}
		return lines.join('\n');
	}

	function previousMeaningful(text, index) {
		while (index >= 0) {
			const ch = text[index];
			if (ch !== ' ' && ch !== '\t' && ch !== '\r' && ch !== '\n') {
				return ch;
			}
			index--;
		}
		return '';
	}

	function nextMeaningful(text, index) {
		while (index < text.length) {
			const ch = text[index];
			if (ch !== ' ' && ch !== '\t' && ch !== '\r' && ch !== '\n') {
				return ch;
			}
			index++;
		}
		return '';
	}

	const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false|null)|([{}\[\],:])/g;

	function highlight(text) {
		const fragment = document.createDocumentFragment();
		let last = 0;
		let match;
		TOKEN.lastIndex = 0;
		while ((match = TOKEN.exec(text)) !== null) {
			if (match.index > last) {
				fragment.append(text.slice(last, match.index));
			}
			if (match[1] !== undefined) {
				const isKey = match[2] !== undefined;
				fragment.append(span(isKey ? 'tok-key' : 'tok-str', match[1]));
				if (isKey) {
					fragment.append(match[2]);
				}
			} else if (match[3] !== undefined) {
				fragment.append(span('tok-num', match[3]));
			} else if (match[4] !== undefined) {
				fragment.append(span('tok-lit', match[4]));
			} else {
				fragment.append(span('tok-punc', match[5]));
			}
			last = TOKEN.lastIndex;
		}
		if (last < text.length) {
			fragment.append(text.slice(last));
		}
		return fragment;
	}

	function span(className, text) {
		const element = document.createElement('span');
		element.className = className;
		element.textContent = text;
		return element;
	}

	let scheduled = false;
	viewport.addEventListener('scroll', () => {
		if (scheduled) {
			return;
		}
		scheduled = true;
		requestAnimationFrame(() => {
			scheduled = false;
			render();
		});
	});

	window.addEventListener('resize', () => {
		// Expanded rows re-wrap at the new width, so their heights are unknown until measured again.
		for (const index of expanded) {
			heights[index] = ROW_H;
		}
		for (const element of rows.values()) {
			element.remove();
		}
		rows.clear();
		layout();
		render();
	});
})();
