/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as vscode from 'vscode';
import { createInlineCompletionItemProvider } from './completions/create-inline-completion-item-provider';
import { AideAgentSessionProvider } from './completions/providers/aideAgentProvider';
import { CSEventHandler } from './csEvents/csEventHandler';
import { ReactDevtoolsManager } from './devtools/react/DevtoolsManager';
import { getGitCurrentHash, getGitRepoName } from './git/helper';
import { aideCommands } from './inlineCompletion/commands';
import { startupStatusBar } from './inlineCompletion/statusBar';
import logger from './logger';
import postHogClient from './posthog/client';
import { AideQuickFix } from './quickActions/fix';
import { RecentEditsRetriever } from './server/editedFiles';
import { RepoRef, RepoRefBackend, SideCarClient } from './sidecar/client';
import { getSideCarModelConfiguration } from './sidecar/types';
import { SimpleBrowserManager } from './simpleBrowser/simpleBrowserManager';
import { loadOrSaveToStorage } from './storage/types';
import { copySettings, migrateFromVSCodeOSS } from './utilities/copySettings';
import { killProcessOnPort } from './utilities/killPort';
import { getRelevantFiles, shouldTrackFile } from './utilities/openTabs';
import { findPortPosition } from './utilities/port';
import { checkReadonlyFSMode } from './utilities/readonlyFS';
import { restartSidecarBinary, setupSidecar } from './utilities/setupSidecarBinary';
import { sidecarURL, sidecarUseSelfRun } from './utilities/sidecarUrl';
import { getUniqueId } from './utilities/uniqueId';
import { ProjectContext } from './utilities/workspaceContext';

export let SIDECAR_CLIENT: SideCarClient | null = null;

const showBrowserCommand = 'codestory.show-simple-browser';

export async function activate(context: vscode.ExtensionContext) {
	const session = await vscode.csAuthentication.getSession();
	const email = session?.account.email ?? '';

	// Project root here
	const uniqueUserId = getUniqueId();
	logger.info(`[CodeStory]: ${uniqueUserId} Activating extension with storage: ${context.globalStorageUri}`);
	postHogClient?.capture({
		distinctId: getUniqueId(),
		event: 'extension_activated',
		properties: {
			platform: os.platform(),
			product: 'aide',
			email,
		},
	});

	let rootPath = vscode.workspace.rootPath;
	if (!rootPath) {
		rootPath = '';
	}

	// Create the copy settings from vscode command for the extension
	const registerCopySettingsCommand = vscode.commands.registerCommand(
		'codestory.importSettings',
		async () => await copySettings(logger)
	);
	context.subscriptions.push(registerCopySettingsCommand);
	migrateFromVSCodeOSS(logger);

	const readonlyFS = checkReadonlyFSMode();
	if (readonlyFS) {
		vscode.window.showErrorMessage('Move Aide to the Applications folder using Finder. More instructions here: [link](https://docs.codestory.ai/troubleshooting#macos-readonlyfs-warning)');
		return;
	}

	// Now we get all the required information and log it
	const repoName = await getGitRepoName(rootPath);
	const repoHash = await getGitCurrentHash(rootPath);

	// We also get some context about the workspace we are in and what we are upto
	const projectContext = new ProjectContext();
	await projectContext.collectContext();

	postHogClient?.capture({
		distinctId: await getUniqueId(),
		event: 'activated_lsp',
		properties: {
			product: 'aide',
			email,
			repoName,
			repoHash,
		}
	});

	// Setup the sidecar client here
	const sidecarDisposable = await setupSidecar(context.globalStorageUri.fsPath);
	context.subscriptions.push(sidecarDisposable);
	vscode.sidecar.onDidTriggerSidecarRestart(() => {
		restartSidecarBinary(context.globalStorageUri.fsPath);
	});

	// Get model selection configuration
	const modelConfiguration = await vscode.modelSelection.getConfiguration();
	const sidecarClient = new SideCarClient(modelConfiguration);
	SIDECAR_CLIENT = sidecarClient;

	// we want to send the open tabs here to the sidecar
	const openTextDocuments = await getRelevantFiles();
	openTextDocuments.forEach((openTextDocument) => {
		// not awaiting here so we can keep loading the extension in the background
		if (shouldTrackFile(openTextDocument.uri)) {
			sidecarClient.documentOpen(openTextDocument.uri.fsPath, openTextDocument.contents, openTextDocument.language);
		}
	});
	// Setup the current repo representation here
	const currentRepo = new RepoRef(
		// We assume the root-path is the one we are interested in
		rootPath,
		RepoRefBackend.local,
	);
	// setup the callback for the model configuration
	vscode.modelSelection.onDidChangeConfiguration((config) => {
		sidecarClient.updateModelConfiguration(config);
	});
	vscode.modelSelection.registerModelConfigurationValidator({
		async provideModelConfigValidation(config) {
			if (!session) {
				return { valid: false, error: 'You must be logged in' };
			}

			const sidecarModelConfig = await getSideCarModelConfiguration(config, session.accessToken);
			return sidecarClient.validateModelConfiguration(sidecarModelConfig);
		},
	});

	// register the inline code completion provider
	await createInlineCompletionItemProvider(
		{
			triggerNotice: notice => {
				console.log(notice);
			},
			sidecarClient,
		}
	);
	// register the commands here for inline completion
	aideCommands();
	// set the status bar as well
	startupStatusBar();

	// Get the storage object here
	const codeStoryStorage = await loadOrSaveToStorage(context.globalStorageUri.fsPath, rootPath);
	logger.info(codeStoryStorage);
	logger.info(rootPath);

	/*
	// Register the semantic search command here
	vscode.commands.registerCommand('codestory.semanticSearch', async (prompt: string): Promise<CodeSymbolInformationEmbeddings[]> => {
		logger.info('[semanticSearch][extension] We are executing semantic search :' + prompt);
		postHogClient?.capture({
			distinctId: await getUniqueId(),
			event: 'search',
			properties: {
				prompt,
				repoName,
				repoHash,
			},
		});
		// We should be using the searchIndexCollection instead here, but for now
		// embedding search is fine
		// Here we will ping the semantic client instead so we can get the results
		const results = await sidecarClient.getSemanticSearchResult(
			prompt,
			currentRepo,
		);
		return results;
	});
	*/

	// Gets access to all the events the editor is throwing our way
	const csEventHandler = new CSEventHandler(context);
	context.subscriptions.push(csEventHandler);

	// Register the quick action providers
	const aideQuickFix = new AideQuickFix();
	vscode.languages.registerCodeActionsProvider('*', aideQuickFix);

	// add the recent edits retriver to the subscriptions
	// so we can grab the recent edits very quickly
	const recentEditsRetriever = new RecentEditsRetriever(30 * 1000, vscode.workspace);
	context.subscriptions.push(recentEditsRetriever);

	// Register the agent session provider
	const agentSessionProvider = new AideAgentSessionProvider(
		currentRepo,
		projectContext,
		sidecarClient,
		csEventHandler,
		recentEditsRetriever,
		context,
	);
	context.subscriptions.push(agentSessionProvider);

	// When the selection changes in the editor we should trigger an event
	vscode.window.onDidChangeTextEditorSelection(async (event) => {
		const textEditor = event.textEditor;
		if (shouldTrackFile(textEditor.document.uri)) {
			// track the changed selection over here
			const selections = event.selections;
			if (selections.length !== 0) {
				await csEventHandler.onDidChangeTextDocumentSelection(textEditor.document.uri.fsPath, selections);
			}
		}
	});

	// Listen to all the files which are changing, so we can keep our tree sitter cache hot
	vscode.workspace.onDidChangeTextDocument(async (event) => {
		const documentUri = event.document.uri;
		// if its a schema type, then skip tracking it
		if (documentUri.scheme === 'vscode') {
			return;
		}
		// TODO(skcd): we want to send the file change event to the sidecar over here
		if (shouldTrackFile(documentUri)) {
			await sidecarClient.documentContentChange(
				documentUri.fsPath,
				event.contentChanges,
				event.document.getText(),
				event.document.languageId,
			);
		}
	});

	const diagnosticsListener = vscode.languages.onDidChangeDiagnostics(async (event) => {
		for (const uri of event.uris) {
			// filter out diagnostics which are ONLY errors and warnings
			const diagnostics = vscode.languages.getDiagnostics(uri).filter((diagnostic) => {
				return (diagnostic.severity === vscode.DiagnosticSeverity.Error || diagnostic.severity === vscode.DiagnosticSeverity.Warning);
			});

			// Send diagnostics to sidecar
			try {
				await sidecarClient.sendDiagnostics(uri.toString(), diagnostics);
			} catch (error) {
				// console.error(`Failed to send diagnostics for ${uri.toString()}:`, error);
			}
		}
	});

	vscode.window.onDidChangeActiveTextEditor(async (editor) => {
		if (editor) {
			const activeDocument = editor.document;
			if (activeDocument) {
				const activeDocumentUri = activeDocument.uri;
				if (shouldTrackFile(activeDocumentUri)) {
					// track that changed document over here
					await sidecarClient.documentOpen(
						activeDocumentUri.fsPath,
						activeDocument.getText(),
						activeDocument.languageId
					);
				}
			}
		}
	});

	// shouldn't all listeners have this?
	context.subscriptions.push(diagnosticsListener);

	// Contains bindings to react devtools headless frontend
	const reactDevtoolsManager = new ReactDevtoolsManager();

	const simpleBrowserManager = new SimpleBrowserManager(context.extensionUri);
	context.subscriptions.push(simpleBrowserManager);
	// Open simple browser command
	context.subscriptions.push(vscode.commands.registerCommand(showBrowserCommand, async (url?: string) => {

		const prefilledUrl = 'http://localhost:3000';
		const portPosition = findPortPosition(prefilledUrl);

		if (!url) {
			url = await vscode.window.showInputBox({
				placeHolder: vscode.l10n.t("https://localhost:3000"),
				value: prefilledUrl,
				valueSelection: portPosition ? [portPosition.start, portPosition.end] : undefined,
				prompt: vscode.l10n.t("Insert the url of your dev server")
			});
		}

		if (url) {
			try {
				const parsedUrl = new URL(url);
				if (reactDevtoolsManager.status === 'server-connected') {
					const proxyedPort = await reactDevtoolsManager.proxy(Number(parsedUrl.port));
					const proxyedUrl = new URL(parsedUrl);
					proxyedUrl.port = proxyedPort.toString();
					simpleBrowserManager.show(proxyedUrl.href);
				} else {
					console.error('Devtools are not ready');
				}
			} catch (err) {
				vscode.window.showErrorMessage('The URL you provided is not valid');
			}
		}
	}));
}

export async function deactivate() {
	if (!sidecarUseSelfRun()) {
		const sidecarUrl = sidecarURL();
		const port = parseInt(sidecarUrl.split(':').at(-1) ?? '42424');
		await killProcessOnPort(port);
	}
}
