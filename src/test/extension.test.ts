import * as assert from 'assert';

// VS Code test harness lets us access VS Code APIs here.
// This file is only a placeholder sample test.
import * as vscode from 'vscode';
// import * as myExtension from '../../extension';

// Mocha's "suite" groups tests together.
suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	// A trivial sample test (replace with real tests later).
	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});
});
