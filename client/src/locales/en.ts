const en = {
  'common.back': 'Back',
  'common.next': 'Next',
  'common.skip': 'Skip',
  'common.saved': 'Saved',
  'common.settings': 'Settings',
  'common.language': 'Language',
  'common.openChatAria': 'Open chat',
  'common.peerInputAria': 'Peer UUID or username',
  'common.copyInviteAria': 'Copy my invite link',
  'common.createGroupAria': 'Create group E2E',
  'common.toggleLanguageAria': 'Toggle language',

  'login.usernameRequired': 'Username is required.',
  'login.passwordRequired': 'Passphrase is required.',
  'login.pinMin8': 'Passphrase must be at least 8 characters for new keys.',
  'login.noLocalVault':
    'No local vault for this handle. Register on this device first.',
  'login.vaultExists': 'A vault already exists for this handle. Use login.',
  'login.unwrapFailed': 'Wrong passphrase or corrupted vault.',
  'login.invalidVaultFormat': 'Vault data is invalid.',
  'login.legacyVault':
    'This vault predates ECDSA auth. Register a new handle or clear local data.',
  'login.invalidSigningKey': 'Could not load signing key from vault.',
  'login.signFailed': 'Signing the challenge failed.',
  'login.challengeFailed': 'Could not reach auth server.',
  'login.verifyFailed': 'Verification failed.',
  'login.unauthorized': 'Session invalid.',
  'login.noChallenge': 'No active challenge, try again.',
  'login.nonceMismatch': 'Challenge mismatch, try again.',
  'login.signatureInvalid': 'Signature rejected by server.',
  'login.publicKeyRequired': 'Server expected a public key (registration).',
  'login.publicKeyConflict':
    'This handle is already registered on the server with a different key. Use Login with your original vault, pick another handle, or reset the server DB and local site data.',
  'login.usernameTaken': 'That handle is already taken.',
  'login.invalidUsernameFormat':
    'Handle must be 3–20 characters: English letters, digits, dot, underscore, or hyphen only (no spaces or emoji).',
  'login.usernameReserved': 'That handle is reserved. Choose another.',
  'login.invalidBody': 'Invalid request.',
  'login.handleLabel': 'Handle',
  'login.vaultPassphraseLabel': 'Vault passphrase',
  'login.handlePlaceholder': 'operator',
  'login.authLoading': 'Checking session...',
  'login.newDevice': 'New device',
  'login.existingVault': 'Existing vault',
  'login.totpTitle': 'SECOND_GATE',
  'login.totpSubtitle': 'TOTP · GOOGLE AUTHENTICATOR COMPATIBLE',
  'login.totpCodeLabel': '6-digit code',
  'login.totpSubmit': 'VERIFY',
  'login.totpBack': 'Back to sign-in',
  'login.totpInvalid': 'Invalid or expired one-time code.',
  'login.totpPendingInvalid': 'Session step expired. Sign in again.',
  'login.totpVerifyFailed': 'Two-factor verification failed.',
  'login.totpSixDigits': 'Enter exactly 6 digits.',
  'login.clientDeviceRequired':
    'This browser must send a device id. Reload the page and try again.',
  'login.deviceRevoked': 'This device was revoked. Sign in from an allowed device or import your vault.',
  'login.vaultRecoveryTitle': 'Vault recovery (before login)',
  'login.vaultRecoveryImport': 'IMPORT_VAULT_FILE',
  'login.vaultRecoveryOk':
    'Encrypted vault stored for this handle. You can sign in with your passphrase.',
  'login.tosRegisterTitle': '[ EN ] Terms of Service',
  'login.tosRegisterBody': `Privacy & Encryption: This service provides End-to-End encryption. We physically cannot access your messages or keys. Losing your Vault passphrase means permanent loss of your chat history.

Zero Liability Zone: By entering, you accept full responsibility for your actions at your own risk. This is a free board. We do not moderate content, we are not liable for it, and we do not care how you use these tools. Every user is solely responsible for the consequences of their actions.

Limitation of Liability: The service is provided "As-Is". The administration is not liable for any damages or data loss.

Right to Terminate: This is a private bunker. The administration reserves the right to ban any account at any time, without prior notice or explanation.`,

  'guide.step': 'Step',
  'guide.onboardingTitle': 'Onboarding',
  'guide.enter': 'Enter Project 13',
  'guide.keyGeneration.title': 'Key generation',
  'guide.keyGeneration.body':
    'When you register, your browser generates two cryptographic key pairs: ECDSA (authentication) and ECDH (E2E encryption). Private keys never leave your device.',
  'guide.vaultEncryption.title': 'Vault encryption',
  'guide.vaultEncryption.body':
    'Your private keys are wrapped with AES-256-GCM using a passphrase-derived key (PBKDF2, 210k iterations). The encrypted vault is stored in localStorage.',
  'guide.zeroKnowledge.title': 'Zero knowledge',
  'guide.zeroKnowledge.body':
    'The server stores only public keys and encrypted message blobs. It cannot read messages or decrypt media.',
  'guide.discoverability.title': 'Discoverability',
  'guide.discoverability.body':
    'You can hide from username search in Settings (Discoverable). Others need it on to be found by name; invite links always work.',
  'guide.backup.title': 'Back up your vault',
  'guide.backup.body':
    'Use Settings -> Export Vault to save an encrypted backup. Import it on a new device to restore access.',

  'sidebar.channels': 'Channels',
  'sidebar.openDirect': 'Open direct',
  'sidebar.peerPlaceholder': 'peer UUID or username',
  'sidebar.copyInviteSuccess': 'Invite link copied',
  'sidebar.userNotFound': 'User not found or hidden',
  'sidebar.cannotOpenSelf': 'You cannot open a direct chat with yourself',
  'sidebar.createFailed': 'Failed to create chat',

  'group.dialogAria': 'Create encrypted group',
  'group.title': '[ NEW_GROUP_E2E ]',
  'group.hintEcdh':
    'Each member must have ECDH published (unlock vault once so keys sync to the server).',
  'group.channelName': '> CHANNEL_NAME',
  'group.optional': 'optional',
  'group.searchLabel': '> RADAR_SEARCH',
  'group.searchPlaceholder': 'username, UUID, or pasted invite link',
  'group.scanning': 'SCAN…',
  'group.noHits':
    'NO_HITS — user must be discoverable in Settings, or search by exact UUID / invite.',
  'group.noEcdhBadge': 'NO_ECDH',
  'group.selectedLabel': ':: selected',
  'group.selectHint': 'Pick at least one user from the list above.',
  'group.create': 'CREATE',
  'group.creating': '…',
  'group.cancel': 'CANCEL',
  'group.noVault': 'Session vault is locked — unlock the vault first.',
  'group.noSession': 'No user id in session — reload the page.',
  'group.needMember': 'Add at least one other member.',
  'group.missingEcdh':
    'User «{name}» has no ECDH on the server — they must unlock vault once.',
  'group.lookupFailed': 'Could not load user profiles from the server.',
  'group.unknownUser': 'One of the users does not exist on the server.',
  'group.createFailed': 'Group creation failed.',
  'group.timeout': 'Request timed out — try again or check the network.',
  'group.serverInvalid': 'Invalid request to server.',
  'group.serverDuplicate': 'Duplicate member in request.',
  'group.creatorMissing': 'Creator must be included in the member list.',
  'group.packSettings': 'PACK :: SETTINGS',
  'group.copyInviteLink': '[ COPY_INVITE_LINK ]',
  'group.inviteGenerateHint':
    'Generate a link to show the brutalist invite URL here.',
  'group.makeAdmin': 'ADMIN',
  'group.demoteMember': 'MEMBER',
  'group.transferOwner': 'OWNER',
  'group.kick': 'KICK',
  'group.kickConfirm': 'Remove this member from the pack?',

  'join.working': 'Joining secure channel…',
  'join.failed': 'Could not join',
  'join.back': 'Back to app',

  'settings.discoverable': 'Discoverable',
  'settings.discoverableHint':
    'Lets others find you by username. To find someone else, they must enable this too.',
  'settings.discoverableBadgeOn': '● visible in username search',
  'settings.discoverableBadgeOff': '○ hidden from username search',
  'settings.discoverableTooltipOn': 'Others can find you by nickname (search)',
  'settings.discoverableTooltipOff': 'You are not listed in nickname search',
  'settings.loadFailed': 'Could not load settings (check login / network)',
  'settings.vaultBackup': 'Vault backup',
  'settings.vaultBackupHint':
    'JSON export or .key “physical key”; ciphertext only — passphrase stays offline.',
  'settings.vaultExportJson': 'EXPORT_JSON',
  'settings.vaultExportKey': 'DOWNLOAD_PHYSICAL_KEY',
  'settings.vaultImport': 'IMPORT',
  'settings.tabDevices': 'DEVICES',
  'settings.devicesSectionTitle': 'УСТРОЙСТВА / DEVICES',
  'settings.devicesHint':
    'Sessions bound to this browser profile. Revoke to invalidate that session JWT.',
  'settings.devicesCurrent': 'CURRENT',
  'settings.devicesRevoked': 'REVOKED',
  'settings.devicesRevoke': 'REVOKE',
  'settings.devicesRevokeConfirm':
    'Revoke this device? It will be signed out on the next request.',
  'settings.recoveryMnemonicTitle': 'BIP39 recovery phrase (12 words)',
  'settings.recoveryMnemonicHint':
    'Offline backup only. Never share. Does not replace your vault passphrase for login.',
  'settings.recoveryMnemonicGenerate': 'GENERATE_PHRASE',
  'settings.recoveryMnemonicWarn':
    'Write these words on paper and store offline. Clear screen when done.',
  'settings.recoveryMnemonicAck': 'I wrote the phrase offline',
  'settings.recoveryMnemonicDone': 'CLEAR',
  'settings.languageHint': 'Choose interface language',
  'settings.noLocalVault': 'No local vault',
  'settings.invalidVaultFile': 'Invalid vault file',
  'settings.importFailed': 'Import failed',
  'settings.toggleFailed': 'Failed to update setting',
  'settings.unknown': 'Unknown error',
  'settings.dangerZone': 'Danger zone',
  'settings.purgeHint':
    'Clears localStorage, sessionStorage, and the message IndexedDB — use when debugging corrupt local state.',
  'settings.purgeLocalCache': 'PURGE LOCAL CACHE',
  'settings.totpSection': 'Security / 2FA',
  'settings.totpHint':
    'Time-based one-time passwords (RFC 6238). Scan the QR in your authenticator app.',
  'settings.totpActive': '2FA is active',
  'settings.totpInactive': '2FA is off',
  'settings.totpSetup': 'SETUP_2FA',
  'settings.totpScanQr': 'Scan this QR with your authenticator app, then enter a code to confirm.',
  'settings.totpSecretManual': 'Manual secret (base32)',
  'settings.totpEnableCode': 'Confirmation code',
  'settings.totpConfirm': 'CONFIRM & ENABLE',
  'settings.totpCancelSetup': 'Cancel setup',
  'settings.totpDisable': 'DISABLE_2FA',
  'settings.totpDisableWarn':
    'Disabling 2FA weakens your account. You will need a valid code from your app.',
  'settings.totpDisableCode': 'Current authenticator code',

  'settings.tabGeneral': 'MAIN',
  'settings.tabMedia': 'SENSORS',
  'settings.mediaSectionTitle': 'СЕНСОРЫ / MEDIA DEVICES',
  'settings.mediaHint':
    'Enumerate inputs; preview requires camera permission. Output routing uses setSinkId where supported.',
  'settings.mediaCamera': 'Camera',
  'settings.mediaMic': 'Microphone',
  'settings.mediaSpeaker': 'Speaker output',
  'settings.mediaDefault': '— system default —',
  'settings.mediaNoise': 'Noise suppression & echo cancellation',
  'settings.mediaNoiseHint': 'Maps to echoCancellation + noiseSuppression in capture constraints.',
  'settings.mediaViewfinder': 'VIEWFINDER',
  'settings.mediaNoApi': 'MediaDevices API unavailable in this context.',
  'settings.mediaDenied':
    'Camera or microphone access was denied. Allow permission in the browser to preview devices.',
  'settings.mediaPreviewFailed': 'Could not start preview stream.',
} as const

export default en

