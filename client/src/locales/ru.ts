const ru = {
  'common.back': 'Назад',
  'common.next': 'Далее',
  'common.skip': 'Пропустить',
  'common.saved': 'Сохранено',
  'common.settings': 'Настройки',
  'common.language': 'Язык',
  'common.openChatAria': 'Открыть чат',
  'common.peerInputAria': 'UUID или имя пользователя',
  'common.copyInviteAria': 'Скопировать мою ссылку-приглашение',
  'common.createGroupAria': 'Создать E2E группу',
  'common.toggleLanguageAria': 'Переключить язык',
  'common.dismiss': 'Закрыть',
  'common.logout': 'ВЫХОД',
  'common.openSettings': 'НАСТРОЙКИ',
  'common.adminWarden': 'СМОТРИТЕЛЬ',

  'settings.logoutSystem': 'ВЫЙТИ_ИЗ_СИСТЕМЫ',

  'pushOnboarding.banner':
    'ВКЛЮЧИТЕ PUSH, ЧТОБЫ ПОЛУЧАТЬ СООБЩЕНИЯ В ФОНЕ',
  'pushOnboarding.enable': 'ВКЛЮЧИТЬ',

  'errors.boundaryGeneric': 'Сигнал потерян. Повторите попытку.',
  'errors.signalLost': 'СИГНАЛ ПОТЕРЯН',
  'errors.retrySession': 'Перезагрузить',
  'errors.generic': 'Ошибка',

  'attach.pickAria': 'Прикрепить файл',
  'attach.transmit': '[ TX ]',
  'attach.clear': '[ СБРОС ]',
  'attach.removeAria': 'Убрать из очереди',

  'media.loading': '…',
  'media.download': 'СКАЧАТЬ',
  'media.permissionDenied':
    'Доступ к микрофону или камере запрещён. На iPhone: Настройки → Safari → Камера/Микрофон → разрешить для этого сайта (нужен HTTPS).',

  'call.openChannels': 'Список каналов',
  'call.mediaPermissionDenied':
    'Для звонков нет доступа к микрофону или камере. Проверьте разрешения Safari и сайта.',

  'login.usernameRequired': 'Требуется имя пользователя.',
  'login.passwordRequired': 'Требуется парольная фраза.',
  'login.pinMin8':
    'Для новых ключей парольная фраза должна быть не короче 8 символов.',
  'login.noLocalVault':
    'Для этого пользователя нет локального vault. Сначала зарегистрируйтесь на этом устройстве.',
  'login.vaultExists':
    'Для этого пользователя уже есть vault. Используйте вход.',
  'login.unwrapFailed': 'Неверная парольная фраза или поврежденный vault.',
  'login.invalidVaultFormat': 'Данные vault имеют неверный формат.',
  'login.legacyVault':
    'Этот vault создан до ECDSA-авторизации. Зарегистрируйте новый логин или очистите локальные данные.',
  'login.invalidSigningKey':
    'Не удалось загрузить ключ подписи из vault.',
  'login.signFailed': 'Не удалось подписать challenge.',
  'login.challengeFailed': 'Не удалось связаться с сервером авторизации.',
  'login.verifyFailed': 'Проверка не выполнена.',
  'login.unauthorized': 'Сессия недействительна.',
  'login.noChallenge': 'Нет активного challenge, попробуйте снова.',
  'login.nonceMismatch': 'Несовпадение challenge, попробуйте снова.',
  'login.signatureInvalid': 'Подпись отклонена сервером.',
  'login.publicKeyRequired':
    'Сервер ожидал публичный ключ (регистрация).',
  'login.publicKeyConflict':
    'Этот логин уже зарегистрирован на сервере с другим ключом. Войдите с тем же vault, выберите другое имя или сбросьте БД на сервере и локальные данные сайта.',
  'login.usernameTaken': 'Этот логин уже занят.',
  'login.invalidUsernameFormat':
    'Логин: 3–20 символов, только латиница, цифры, точка, подчёркивание или дефис (без пробелов и эмодзи).',
  'login.usernameReserved': 'Этот логин зарезервирован. Выберите другой.',
  'login.invalidBody': 'Неверный запрос.',
  'login.handleLabel': 'Логин',
  'login.vaultPassphraseLabel': 'Парольная фраза vault',
  'login.handlePlaceholder': 'оператор',
  'login.authLoading': 'Проверка сессии...',
  'login.newDevice': 'Новое устройство',
  'login.qrLinkSection': 'ПРИВЯЗКА_ПО_QR_ТОКЕНУ',
  'login.qrLinkHint':
    'Вставьте токен с экрана QR на другом устройстве, где вы уже вошли. Этот браузер должен отправлять id устройства (создаётся автоматически).',
  'login.qrTokenPlaceholder': 'uuid токена с экрана QR',
  'login.qrLinkSubmit': 'АКТИВИРОВАТЬ_ТОКЕН',
  'login.qrTokenInvalid': 'Токен похож на неверный (ожидается UUID).',
  'login.existingVault': 'Существующий vault',
  'login.totpTitle': 'ВТОРОЙ_КОНТУР',
  'login.totpSubtitle': 'TOTP · СОВМЕСТИМОСТЬ С GOOGLE AUTHENTICATOR',
  'login.totpCodeLabel': 'Код из 6 цифр',
  'login.totpSubmit': 'ПОДТВЕРДИТЬ',
  'login.totpBack': 'Назад ко входу',
  'login.totpInvalid': 'Неверный или просроченный одноразовый код.',
  'login.totpPendingInvalid': 'Шаг сессии истёк. Войдите снова.',
  'login.totpVerifyFailed': 'Ошибка двухфакторной проверки.',
  'login.totpSixDigits': 'Введите ровно 6 цифр.',
  'login.clientDeviceRequired':
    'Браузер должен отправить идентификатор устройства. Обновите страницу.',
  'login.deviceRevoked':
    'Это устройство отозвано. Войдите с другого или импортируйте vault.',
  'login.vaultRecoveryTitle': 'Восстановление vault (до входа)',
  'login.vaultRecoveryImport': 'ИМПОРТ_ФАЙЛА_VAULT',
  'login.vaultRecoveryOk':
    'Зашифрованный vault сохранён для этого ника. Можно войти с парольной фразой.',
  'login.vaultImportHandleMissing':
    'В файле нет поля username, а поле логина пустое. Используйте резервную копию из настроек (в ней есть ваш ник) или введите тот же латинский логин, что при регистрации, затем снова импорт.',
  'login.tosRegisterTitle': '[ RU ] Пользовательское соглашение',
  'login.tosRegisterBody': `Приватность и Шифрование: Сервис предоставляет сквозное (End-to-End) шифрование. Мы физически не имеем доступа к вашим сообщениям и ключам. Потеря пароля от Сейфа означает безвозвратную потерю доступа к переписке.

Свободная зона (Zero Liability): Вход в систему означает полное согласие с тем, что вы действуете на свой страх и риск. Это свободное пространство. Мы не модерируем контент, не несем за него ответственности и нас не волнует, как вы используете этот инструмент. Каждый пользователь лично отвечает за свои действия.

Ограничение ответственности: Сервис предоставляется "как есть". Администрация не несет ответственности за ущерб, потерю данных или последствия использования приложения.

Право на изоляцию: Это частный бункер. Администрация оставляет за собой право заблокировать (забанить) любой аккаунт без объяснения причин, если он угрожает стабильности системы.`,

  'guide.step': 'Шаг',
  'guide.onboardingTitle': 'Онбординг',
  'guide.enter': 'Войти в Project 13',
  'guide.keyGeneration.title': 'Генерация ключей',
  'guide.keyGeneration.body':
    'При регистрации браузер создает две пары ключей: ECDSA (авторизация) и ECDH (E2E шифрование). Приватные ключи не покидают устройство.',
  'guide.vaultEncryption.title': 'Шифрование vault',
  'guide.vaultEncryption.body':
    'Приватные ключи упаковываются AES-256-GCM с ключом из парольной фразы (PBKDF2, 210k итераций). Зашифрованный vault хранится в localStorage.',
  'guide.zeroKnowledge.title': 'Zero knowledge',
  'guide.zeroKnowledge.body':
    'Сервер хранит только публичные ключи и зашифрованные сообщения. Он не может читать сообщения или расшифровывать медиа.',
  'guide.discoverability.title': 'Обнаруживаемость',
  'guide.discoverability.body':
    'Можно скрыться из поиска по нику в настройках (Обнаруживаемость). Чтобы искать других по имени, у них тоже должна быть включена опция; ссылки-приглашения работают всегда.',
  'guide.backup.title': 'Резервная копия vault',
  'guide.backup.body':
    'Используйте Settings -> Export Vault, чтобы сохранить зашифрованную копию. На новом устройстве импортируйте ее для восстановления доступа.',

  'sidebar.localGhostSearch':
    'Поиск по кэшу (только локально, IndexedDB)…',
  'sidebar.ghostNoHits': 'Нет совпадений в локальном кэше.',
  'sidebar.channels': 'Каналы',
  'sidebar.openDirect': 'Личный чат',
  'sidebar.peerPlaceholder': 'UUID или имя пользователя',
  'sidebar.copyInviteSuccess': 'Ссылка-приглашение скопирована',
  'sidebar.userNotFound': 'Пользователь не найден или скрыт',
  'sidebar.cannotOpenSelf': 'Нельзя открыть личный чат с самим собой',
  'sidebar.createFailed': 'Не удалось создать чат',
  'sidebar.copyMyInvite': 'СКОПИРОВАТЬ_ИНВАЙТ',
  'sidebar.createGroupE2e': 'СОЗДАТЬ_ГРУППУ_E2E',
  'sidebar.openPeer': 'ОТКРЫТЬ',
  'sidebar.noActiveRoutes': 'НЕТ_АКТИВНЫХ_МАРШРУТОВ',
  'sidebar.leaveGroup': 'ВЫЙТИ',
  'sidebar.deleteChat': 'УДАЛИТЬ',
  'sidebar.purgeChatConfirm':
    'Удалить локальные данные чата на сервере для этого канала?',
  'sidebar.pin': 'Закрепить',
  'sidebar.unpin': 'Открепить',
  'sidebar.pinAria': 'Закрепить чат',
  'sidebar.unpinAria': 'Открепить чат',
  'sidebar.online': 'В сети',
  'sidebar.lastSeen': 'Был(а)',
  'sidebar.badgeGroup': 'ГРУП',
  'sidebar.badgeDirect': 'ЛИЧ',
  'sidebar.groupUntitled': 'ГРУППА',

  'chat.contextMenuAria': 'Действия с сообщением',
  'chat.contextReply': 'ОТВЕТИТЬ',
  'chat.contextDeleteMe': 'УДАЛИТЬ_У_СЕБЯ',
  'chat.contextDeleteEveryone': 'УДАЛИТЬ_ВЕЗДЕ',
  'chat.emptyTitle': 'ОЖИДАНИЕ СИГНАЛА',
  'chat.emptySubtitle': 'Выберите или создайте канал в боковой панели',
  'chat.noLogsTitle': 'НЕТ_ЗАПИСЕЙ',
  'chat.noLogsHint': 'Ожидание сигнала — отправьте первый пакет.',
  'chat.replyBanner': 'Ответ на',
  'chat.inputPlaceholder': 'введите зашифрованное сообщение',
  'chat.burnTimerLabel': 'ТАЙМЕР / СЖИГАНИЕ',
  'chat.originalDeleted': 'ОРИГИНАЛ_УДАЛЁН',

  'media.capture': 'ЗАХВАТ',
  'media.recLabel': 'ЗАП',
  'media.slideCancel': 'СДВИНЬ_ОТПУСТИТЬ_ОТМЕНА',
  'media.signalLost': 'СИГНАЛ_ПОТЕРЯН',
  'media.holdVoice': 'УДЕРЖИВАТЬ :: ГОЛОС',
  'media.holdCircle': 'УДЕРЖИВАТЬ :: КРУГ',
  'media.recording': 'ЗАП',
  'media.maxSizeLine': 'МАКС_РАЗМЕР_МЕДИА',
  'media.errorGeneric': 'ОШИБКА',

  'emoji.pickerToggle': 'ЭМОДЗИ',
  'emoji.pickerAria': 'Вставить эмодзи',

  'group.dialogAria': 'Создать зашифрованную группу',
  'group.title': '[ NEW_GROUP_E2E ]',
  'group.hintEcdh':
    'У каждого участника должен быть опубликован ECDH (один раз разблокируйте vault — ключи уйдут на сервер).',
  'group.channelName': '> CHANNEL_NAME',
  'group.optional': 'необязательно',
  'group.searchLabel': '> RADAR_SEARCH',
  'group.searchPlaceholder': 'ник, UUID или вставленная ссылка-приглашение',
  'group.scanning': 'СКАН…',
  'group.noHits':
    'НЕТ СОВПАДЕНИЙ — пользователь должен быть «обнаруживаем» в настройках, либо ищите по UUID / ссылке.',
  'group.noEcdhBadge': 'НЕТ_ECDH',
  'group.selectedLabel': ':: выбрано',
  'group.selectHint': 'Выберите хотя бы одного пользователя в списке выше.',
  'group.create': 'СОЗДАТЬ',
  'group.creating': '…',
  'group.cancel': 'ОТМЕНА',
  'group.noVault': 'Vault заблокирован — сначала разблокируйте vault.',
  'group.noSession': 'Нет id пользователя в сессии — перезагрузите страницу.',
  'group.needMember': 'Добавьте хотя бы одного другого участника.',
  'group.missingEcdh':
    'У пользователя «{name}» нет ECDH на сервере — ему нужно один раз разблокировать vault.',
  'group.lookupFailed': 'Не удалось загрузить профили с сервера.',
  'group.unknownUser': 'Один из пользователей не существует на сервере.',
  'group.createFailed': 'Не удалось создать группу.',
  'group.timeout': 'Таймаут запроса — повторите или проверьте сеть.',
  'group.serverInvalid': 'Некорректный запрос к серверу.',
  'group.serverDuplicate': 'Дубликат участника в запросе.',
  'group.creatorMissing': 'Создатель должен быть в списке участников.',
  'group.packSettings': 'СТАЯ :: НАСТРОЙКИ',
  'group.copyInviteLink': '[ КОПИРОВАТЬ_ССЫЛКУ ]',
  'group.inviteGenerateHint':
    'Сгенерируйте ссылку — здесь появится адрес приглашения.',
  'group.oneTimeInvite':
    '[ ОДНОРАЗОВО ] — ссылка сгорит после первого нового участника.',
  'group.makeAdmin': 'АДМИН',
  'group.demoteMember': 'УЧАСТНИК',
  'group.transferOwner': 'ВЛАДЕЛЕЦ',
  'group.kick': 'ВЫГНАТЬ',
  'group.kickConfirm': 'Убрать этого участника из стаи?',

  'join.working': 'Вход в зашифрованный канал…',
  'join.failed': 'Не удалось войти',
  'join.back': 'К приложению',

  'settings.avatarTitle': ':: МЕТКА :: АВАТАР',
  'settings.avatarChoose': '[ ВЫБРАТЬ_ИЗОБРАЖЕНИЕ ]',
  'settings.avatarBusy': '… ПОДПИСЬ / ЗАГРУЗКА …',
  'settings.avatarVaultPin': 'PIN vault (подпись)',
  'settings.avatarPinHint': 'Введите PIN vault (от 8 символов) для подписи загрузки.',
  'settings.avatarInvalidType': 'Выберите файл изображения.',
  'settings.avatarUploadFailed': 'Не удалось загрузить аватар.',
  'group.mediaArchiveTab': 'МЕДИА-АРХИВ / MEDIA ARCHIVE',
  'group.mediaArchiveTitle': 'Голос · аудио · видео в этой стае',
  'group.mediaArchiveLoading': 'Загрузка архива…',
  'group.mediaArchiveEmpty': 'В этом канале пока нет медиа.',

  'settings.discoverable': 'Обнаруживаемость',
  'settings.ghostPresence': 'Режим призрака',
  'settings.ghostPresenceHint':
    'Скрыть онлайн и «был в сети» от других. Их статус вы всё ещё видите.',
  'settings.discoverableHint':
    'Другие смогут найти вас по нику. Чтобы найти кого-то по нику, эта опция должна быть включена у него.',
  'settings.discoverableBadgeOn': '● видны в поиске по нику',
  'settings.discoverableBadgeOff': '○ скрыты из поиска по нику',
  'settings.discoverableTooltipOn': 'Вас можно найти по нику (поиск)',
  'settings.discoverableTooltipOff': 'Вас нет в поиске по нику',
  'settings.notificationsTitle': 'Уведомления',
  'settings.notificationsHint':
    'Фоновые push о новых сообщениях (нужны HTTPS, VAPID и production-сборка со service worker).',
  'settings.pushEnabled': 'PUSH ВКЛЮЧЁН',
  'settings.pushEnable': '[ ВКЛЮЧИТЬ PUSH ]',
  'settings.pushDisable': '[ ОТКЛЮЧИТЬ PUSH ]',
  'settings.pushBlocked':
    'Заблокировано в настройках браузера — разрешите уведомления для этого сайта.',
  'settings.pushUnsupported': 'Web Push недоступен в этом браузере.',
  'settings.pushNoSw':
    'Не удалось зарегистрировать service worker. Нужны HTTPS и production-сборка (next-pwa, /sw.js).',
  'settings.pushVapidMissing':
    'В сборке не задан NEXT_PUBLIC_VAPID_PUBLIC_KEY — push недоступен.',
  'settings.pushGrantNoSubHint':
    'Разрешение выдано — нажмите «включить», чтобы завершить регистрацию на сервере.',
  'settings.loadFailed': 'Не удалось загрузить настройки (сеть или сессия)',
  'settings.vaultBackup': 'Резервная копия vault',
  'settings.vaultBackupHint':
    'JSON или физический ключ .key — только шифротекст; пароль не уходит с устройства.',
  'settings.vaultExportJson': 'ЭКСПОРТ_JSON',
  'settings.vaultExportKey': 'СКАЧАТЬ_ФИЗ_КЛЮЧ',
  'settings.vaultImport': 'ИМПОРТ',
  'settings.tabDevices': 'УСТРОЙСТВА',
  'settings.devicesSectionTitle': 'УСТРОЙСТВА / DEVICES',
  'settings.devicesHint':
    'Сессии привязаны к профилю браузера. Отзыв инвалидирует JWT этого устройства.',
  'settings.devicesCurrent': 'ТЕКУЩЕЕ',
  'settings.devicesRevoked': 'ОТОЗВАНО',
  'settings.devicesRevoke': 'ОТОЗВАТЬ',
  'settings.devicesRevokeConfirm':
    'Отозвать это устройство? Сессия сбросится при следующем запросе.',
  'settings.linkDeviceCta': 'ПРИВЯЗАТЬ_УСТРОЙСТВО_QR',
  'settings.linkDeviceTitle': '[ ПРИВЯЗКА :: НОВОЕ_УСТРОЙСТВО :: QR ]',
  'settings.linkDeviceHint':
    'Сканируйте с экрана входа на новом устройстве (заглушка: TOTP пока не поддержан). Токен ~5 мин.',
  'settings.recoveryMnemonicTitle': 'Фраза восстановления BIP39 (12 слов)',
  'settings.recoveryMnemonicHint':
    'Только офлайн. Не передавайте. Не заменяет пароль vault для входа.',
  'settings.recoveryMnemonicGenerate': 'СГЕНЕРИРОВАТЬ',
  'settings.recoveryMnemonicWarn':
    'Запишите слова на бумаге. Закройте экран после сохранения.',
  'settings.recoveryMnemonicAck': 'Я записал фразу офлайн',
  'settings.recoveryMnemonicDone': 'ОЧИСТИТЬ',
  'settings.languageHint': 'Выберите язык интерфейса',
  'settings.noLocalVault': 'Локальный vault не найден',
  'settings.invalidVaultFile': 'Некорректный файл vault',
  'settings.importFailed': 'Не удалось импортировать',
  'settings.toggleFailed': 'Не удалось обновить настройку',
  'settings.unknown': 'Неизвестная ошибка',
  'settings.dangerZone': 'Опасная зона',
  'settings.purgeHint':
    'Очищает localStorage, sessionStorage и IndexedDB сообщений — для отладки битого локального состояния.',
  'settings.purgeLocalCache': 'ОЧИСТИТЬ ЛОКАЛЬНЫЙ КЭШ',
  'settings.killSwitchHint':
    'Отзывает все сессии на сервере, стирает IndexedDB сообщений/медиа/WebAuthn и очищает хранилище на этом устройстве. Введите фразу точно, затем PIN vault.',
  'settings.killPhraseLabel': 'Фраза подтверждения',
  'settings.killPinLabel': 'PIN vault (проверка)',
  'settings.killExecute': 'ГЛОБАЛЬНОЕ_СТИРАНИЕ',
  'settings.killPhraseMismatch': 'Фраза подтверждения не совпадает.',
  'settings.killPinBad': 'Неверный PIN vault.',
  'settings.totpSection': 'Безопасность / 2FA',
  'settings.totpHint':
    'Одноразовые коды по времени (RFC 6238). Отсканируйте QR в приложении-аутентификаторе.',
  'settings.totpActive': '2FA включена',
  'settings.totpInactive': '2FA выключена',
  'settings.totpSetup': 'НАСТРОИТЬ_2FA',
  'settings.totpScanQr':
    'Отсканируйте QR в приложении, затем введите код для подтверждения.',
  'settings.totpSecretManual': 'Секрет вручную (base32)',
  'settings.totpEnableCode': 'Код подтверждения',
  'settings.totpConfirm': 'ПОДТВЕРДИТЬ И ВКЛЮЧИТЬ',
  'settings.totpCancelSetup': 'Отменить настройку',
  'settings.totpDisable': 'ОТКЛЮЧИТЬ_2FA',
  'settings.totpDisableWarn':
    'Отключение 2FA ослабляет аккаунт. Нужен действующий код из приложения.',
  'settings.totpDisableCode': 'Текущий код из приложения',

  'settings.tabGeneral': 'ОСНОВНОЕ',
  'settings.tabMedia': 'СЕНСОРЫ',
  'settings.mediaSectionTitle': 'СЕНСОРЫ / MEDIA DEVICES',
  'settings.mediaHint':
    'Список устройств; предпросмотр требует разрешения камеры. Вывод — через setSinkId (где поддерживается).',
  'settings.mediaCamera': 'Камера',
  'settings.mediaMic': 'Микрофон',
  'settings.mediaSpeaker': 'Вывод звука',
  'settings.mediaDefault': '— по умолчанию —',
  'settings.mediaNoise': 'Шумоподавление и эхоподавление',
  'settings.mediaNoiseHint':
    'Соответствует echoCancellation и noiseSuppression в ограничениях захвата.',
  'settings.mediaViewfinder': 'ВИДОИСКАТЕЛЬ',
  'settings.mediaNoApi': 'MediaDevices API недоступен в этом контексте.',
  'settings.mediaDenied':
    'Доступ к камере или микрофону запрещён. Разрешите в браузере для предпросмотра.',
  'settings.mediaPreviewFailed': 'Не удалось запустить поток предпросмотра.',

  'settings.digitalDenTitle': 'НОРА :: ЛОКАЛЬНЫЙ КЭШ МЕДИА',
  'settings.digitalDenHint':
    'Расшифрованные blob в IndexedDB (только устройство). При переполнении (~1 ГиБ) удаляются старые.',
  'settings.digitalDenUsage': 'Занято',
  'settings.digitalDenClear': 'ОЧИСТИТЬ КЭШ',
  'settings.digitalDenCleared': 'Кэш очищен.',
  'settings.digitalDenBusy': '…',

  'media.fileExpiredServer': 'Срок хранения на сервере истек.',
} as const

export default ru

