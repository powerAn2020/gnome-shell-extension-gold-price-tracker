import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { HolidayManager } from './holidayManager.js';

const API_URL = 'https://api.jdjygold.com/gw2/generic/jrm/h5/m/stdLatestPrice?productSku=1961543816';

const GoldIndicator = GObject.registerClass(
class GoldIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Gold Price Indicator', false);

        this._extension = extension;
        this._settings = extension.getSettings();

        this._holidayManager = new HolidayManager(this._settings);
        this._powerProxy = null;
        this._powerSignalId = 0;

        this._latestData = null;
        this._lastRefreshTime = null;
        this._cancellable = new Gio.Cancellable();
        this._httpSession = new Soup.Session();
        this._httpSession.timeout = 10;
        this._timeoutId = 0;
        this._settingsSignals = [];

        this._initPowerMonitoring();

        // 构建顶栏 UI
        this._panelBox = new St.BoxLayout({
            style_class: 'gold-tracker-panel-box',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._iconLabel = new St.Label({
            text: '🪙 ',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._priceLabel = new St.Label({
            text: '加载中...',
            style_class: 'gold-tracker-panel-label',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._panelBox.add_child(this._iconLabel);
        this._panelBox.add_child(this._priceLabel);
        this.add_child(this._panelBox);

        // 构建下拉菜单 UI
        this._buildPopupMenu();

        // 绑定配置变动信号
        this._bindSettings();

        // 立即拉取并启动定时器
        this._fetchData();
        this._startTimer();
    }

    _initPowerMonitoring() {
        try {
            const connection = Gio.bus_get_sync(Gio.BusType.SYSTEM, null);
            this._powerProxy = Gio.DBusProxy.new_sync(
                connection,
                Gio.DBusProxyFlags.NONE,
                null,
                'org.freedesktop.UPower',
                '/org/freedesktop/UPower',
                'org.freedesktop.UPower',
                null
            );

            this._powerSignalId = this._powerProxy.connect('g-properties-changed', () => {
                const onBat = this._isOnBattery();
                if (!onBat) {
                    // 恢复市电供电时立即触发一次拉取
                    this._fetchData();
                }
                this._updateUI();
            });
        } catch (e) {
            console.warn(`[GoldTracker] 电源状态监听初始化失败: ${e.message}`);
        }
    }

    _isOnBattery() {
        if (!this._powerProxy) return false;
        try {
            const prop = this._powerProxy.get_cached_property('OnBattery');
            return prop ? prop.get_boolean() : false;
        } catch (e) {
            return false;
        }
    }

    _buildPopupMenu() {
        // 创建不可选中的基础菜单容器
        const menuSection = new PopupMenu.PopupBaseMenuItem({
            activate: false,
            reactive: true,
            can_focus: false,
        });
        menuSection._ornament = false;

        const mainContainer = new St.BoxLayout({
            style_class: 'gold-menu-container',
            vertical: true,
            x_expand: true,
        });

        // ================== 卡片 1：实时行情看板 ==================
        const marketCard = new St.BoxLayout({
            style_class: 'gold-card',
            vertical: true,
            x_expand: true,
        });

        const marketTitleBox = new St.BoxLayout({
            x_expand: true,
        });
        const marketTitle = new St.Label({
            text: '📈 浙商积存金实时行情',
            style_class: 'gold-card-title',
            x_expand: true,
        });
        this._statusTag = new St.Label({
            text: '积存金 99.99%',
            style_class: 'gold-card-title',
        });
        marketTitleBox.add_child(marketTitle);
        marketTitleBox.add_child(this._statusTag);
        marketCard.add_child(marketTitleBox);

        // 价格与涨跌幅主显示行
        const priceRow = new St.BoxLayout({
            style_class: 'gold-market-top',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._menuPriceLabel = new St.Label({
            text: '--.--',
            style_class: 'gold-large-price',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._menuBadgeLabel = new St.Label({
            text: '--',
            style_class: 'gold-badge',
            y_align: Clutter.ActorAlign.CENTER,
        });

        priceRow.add_child(this._menuPriceLabel);
        priceRow.add_child(this._menuBadgeLabel);
        marketCard.add_child(priceRow);

        // 昨收价与行情时间行
        const infoRow = new St.BoxLayout({
            style_class: 'gold-market-subinfo',
            x_expand: true,
        });

        this._menuYesterdayLabel = new St.Label({
            text: '昨日收盘: --.-- 元/g',
            x_expand: true,
        });

        this._menuTimeLabel = new St.Label({
            text: '行情时间: --:--:--',
        });

        infoRow.add_child(this._menuYesterdayLabel);
        infoRow.add_child(this._menuTimeLabel);
        marketCard.add_child(infoRow);

        // 刷新时间与刷新标示行
        const refreshInfoRow = new St.BoxLayout({
            style_class: 'gold-market-subinfo',
            x_expand: true,
        });

        this._menuRefreshTimeLabel = new St.Label({
            text: '最后刷新: 同步中...',
            x_expand: true,
        });

        this._menuRefreshStateLabel = new St.Label({
            text: '● 正在轮询',
        });

        refreshInfoRow.add_child(this._menuRefreshTimeLabel);
        refreshInfoRow.add_child(this._menuRefreshStateLabel);
        marketCard.add_child(refreshInfoRow);

        mainContainer.add_child(marketCard);

        // ================== 卡片 2：持仓与盈亏测算 ==================
        const holdingsCard = new St.BoxLayout({
            style_class: 'gold-card',
            vertical: true,
            x_expand: true,
        });

        const holdingsTitle = new St.Label({
            text: '📊 持仓与收益实时测算',
            style_class: 'gold-card-title',
        });
        holdingsCard.add_child(holdingsTitle);

        // 3项指标统计行
        const statsRow = new St.BoxLayout({
            style_class: 'gold-stat-row',
            x_expand: true,
        });

        // 市值
        const valBox = new St.BoxLayout({
            style_class: 'gold-stat-item',
            vertical: true,
            x_expand: true,
        });
        valBox.add_child(new St.Label({ text: '持有总市值', style_class: 'gold-stat-label' }));
        this._holdingValLabel = new St.Label({ text: '¥ 0.00', style_class: 'gold-stat-val' });
        valBox.add_child(this._holdingValLabel);

        // 今日盈亏
        const todayBox = new St.BoxLayout({
            style_class: 'gold-stat-item',
            vertical: true,
            x_expand: true,
        });
        todayBox.add_child(new St.Label({ text: '今日收益', style_class: 'gold-stat-label' }));
        this._todayPnLLabel = new St.Label({ text: '¥ 0.00', style_class: 'gold-stat-val' });
        todayBox.add_child(this._todayPnLLabel);

        // 累计盈亏
        const totalBox = new St.BoxLayout({
            style_class: 'gold-stat-item',
            vertical: true,
            x_expand: true,
        });
        totalBox.add_child(new St.Label({ text: '累计盈亏', style_class: 'gold-stat-label' }));
        this._totalPnLLabel = new St.Label({ text: '¥ 0.00', style_class: 'gold-stat-val' });
        totalBox.add_child(this._totalPnLLabel);

        statsRow.add_child(valBox);
        statsRow.add_child(todayBox);
        statsRow.add_child(totalBox);
        holdingsCard.add_child(statsRow);

        // 内联快速微调输入行
        const editRow = new St.BoxLayout({
            style_class: 'gold-input-row',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });

        editRow.add_child(new St.Label({ text: '持仓:', y_align: Clutter.ActorAlign.CENTER, style_class: 'gold-stat-label' }));
        this._gramsEntry = new St.Entry({
            style_class: 'gold-entry',
            can_focus: true,
            text: this._settings.get_double('holding-grams').toFixed(4),
        });
        editRow.add_child(this._gramsEntry);
        editRow.add_child(new St.Label({ text: 'g', y_align: Clutter.ActorAlign.CENTER, style_class: 'gold-stat-label' }));

        editRow.add_child(new St.Label({ text: '成本:', y_align: Clutter.ActorAlign.CENTER, style_class: 'gold-stat-label' }));
        this._costEntry = new St.Entry({
            style_class: 'gold-entry',
            can_focus: true,
            text: this._settings.get_double('cost-price').toFixed(2),
        });
        editRow.add_child(this._costEntry);
        editRow.add_child(new St.Label({ text: '元/g', y_align: Clutter.ActorAlign.CENTER, style_class: 'gold-stat-label' }));

        const saveBtn = new St.Button({
            label: '保存',
            style_class: 'gold-save-btn',
            can_focus: true,
            reactive: true,
        });
        saveBtn.connect('clicked', () => this._onSaveHoldings());
        editRow.add_child(saveBtn);

        holdingsCard.add_child(editRow);
        mainContainer.add_child(holdingsCard);

        // ================== 操作按钮栏 ==================
        const actionRow = new St.BoxLayout({
            style_class: 'gold-action-bar',
            x_expand: true,
        });

        const refreshBtn = new St.Button({
            label: '🔄 刷新行情',
            style_class: 'gold-action-btn',
            x_expand: true,
            reactive: true,
        });
        refreshBtn.connect('clicked', () => {
            refreshBtn.label = '🔄 刷新中...';
            this._fetchData(() => {
                refreshBtn.label = '🔄 刷新行情';
            });
        });

        const prefsBtn = new St.Button({
            label: '⚙️ 偏好设置',
            style_class: 'gold-action-btn',
            x_expand: true,
            reactive: true,
        });
        prefsBtn.connect('clicked', () => {
            this.menu.close();
            this._extension.openPreferences();
        });

        const linkBtn = new St.Button({
            label: '🔗 浙商积存金',
            style_class: 'gold-action-btn',
            x_expand: true,
            reactive: true,
        });
        linkBtn.connect('clicked', () => {
            this.menu.close();
            Gio.AppInfo.launch_default_for_uri('https://jdjr.jd.com/', null);
        });

        actionRow.add_child(refreshBtn);
        actionRow.add_child(prefsBtn);
        actionRow.add_child(linkBtn);
        mainContainer.add_child(actionRow);

        menuSection.add_child(mainContainer);
        this.menu.addMenuItem(menuSection);
    }

    _onSaveHoldings() {
        const gramsVal = parseFloat(this._gramsEntry.get_text()) || 0.0;
        const costVal = parseFloat(this._costEntry.get_text()) || 0.0;

        this._settings.set_double('holding-grams', Math.max(0, gramsVal));
        this._settings.set_double('cost-price', Math.max(0, costVal));

        this._updateUI();
    }

    _bindSettings() {
        const keys = [
            'refresh-interval',
            'display-format',
            'color-scheme',
            'show-icon',
            'holding-grams',
            'cost-price',
            'trade-hours-only',
            'battery-saving',
            'morning-session',
            'afternoon-session',
            'night-session',
        ];

        keys.forEach(key => {
            const id = this._settings.connect(`changed::${key}`, () => {
                if (key === 'refresh-interval') {
                    this._startTimer();
                } else if (key === 'holding-grams') {
                    const g = this._settings.get_double('holding-grams');
                    if (this._gramsEntry) this._gramsEntry.set_text(g.toFixed(4));
                    this._updateUI();
                } else if (key === 'cost-price') {
                    const c = this._settings.get_double('cost-price');
                    if (this._costEntry) this._costEntry.set_text(c.toFixed(2));
                    this._updateUI();
                } else {
                    this._updateUI();
                }
            });
            this._settingsSignals.push(id);
        });
    }

    _startTimer() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }

        const interval = Math.max(1, this._settings.get_int('refresh-interval'));
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            // 1. 省电模式检查（电池供电暂停后台自动刷新）
            const batterySaving = this._settings.get_boolean('battery-saving');
            if (batterySaving && this._isOnBattery()) {
                this._updateUI();
                return GLib.SOURCE_CONTINUE;
            }

            // 2. 开市时间与节假日联动检查（休市期间暂停后台自动刷新）
            const tradeHoursOnly = this._settings.get_boolean('trade-hours-only');
            const market = this._holidayManager.isMarketOpen();
            if (tradeHoursOnly && !market.isOpen) {
                this._updateUI();
                return GLib.SOURCE_CONTINUE;
            }

            this._fetchData();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _fetchData(callback = null) {
        const message = Soup.Message.new('GET', API_URL);
        message.request_headers.append('User-Agent', 'Mozilla/5.0');
        message.request_headers.append('Accept', 'application/json');

        this._httpSession.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            this._cancellable,
            (session, res) => {
                try {
                    const bytes = session.send_and_read_finish(res);
                    if (!bytes) return;

                    const decoder = new TextDecoder('utf-8');
                    const text = decoder.decode(bytes.get_data());
                    const json = JSON.parse(text);

                    if (json && json.resultData && json.resultData.datas) {
                        this._latestData = json.resultData.datas;
                        this._lastRefreshTime = new Date();
                        this._updateUI();
                    }
                } catch (e) {
                    if (!this._cancellable.is_cancelled()) {
                        console.warn(`[GoldPriceTracker] 获取金价失败: ${e.message}`);
                    }
                } finally {
                    if (typeof callback === 'function') {
                        callback();
                    }
                }
            }
        );
    }

    _updateUI() {
        if (!this._latestData) return;

        const price = parseFloat(this._latestData.price) || 0.0;
        const yesterdayPrice = parseFloat(this._latestData.yesterdayPrice) || 0.0;
        const upAndDownAmt = parseFloat(this._latestData.upAndDownAmt) || 0.0;
        const upAndDownRate = this._latestData.upAndDownRate || '0.00%';
        const rawTime = parseInt(this._latestData.time, 10);

        // 格式化时间
        let timeStr = '--:--:--';
        if (rawTime > 0) {
            const date = new Date(rawTime);
            timeStr = date.toTimeString().split(' ')[0];
        }

        // 判断涨跌
        const isUp = upAndDownAmt > 0;
        const isDown = upAndDownAmt < 0;
        const isFlat = Math.abs(upAndDownAmt) < 0.0001;

        // 配色逻辑
        const colorScheme = this._settings.get_string('color-scheme');
        let upClass = 'gold-color-up';
        let downClass = 'gold-color-down';
        if (colorScheme === 'green-up-red-down') {
            upClass = 'gold-color-down';
            downClass = 'gold-color-up';
        }

        let activeColorClass = 'gold-color-flat';
        if (isUp) activeColorClass = upClass;
        else if (isDown) activeColorClass = downClass;

        // 状态判定（省电模式 / 开市状态）
        const batterySaving = this._settings.get_boolean('battery-saving');
        const tradeHoursOnly = this._settings.get_boolean('trade-hours-only');
        const market = this._holidayManager.isMarketOpen();
        const onBattery = this._isOnBattery();

        if (this._statusTag) {
            if (onBattery && batterySaving) {
                this._statusTag.set_text('🔋 电池省电中');
            } else if (tradeHoursOnly && !market.isOpen) {
                this._statusTag.set_text(`☕ ${market.reason}`);
            } else {
                this._statusTag.set_text(`🟢 ${market.reason}`);
            }
        }

        // 1. 顶栏更新
        const showIcon = this._settings.get_boolean('show-icon');
        this._iconLabel.visible = showIcon;

        const displayFormat = this._settings.get_string('display-format');
        let panelText = price.toFixed(2);
        if (displayFormat === 'price-rate') {
            panelText = `${price.toFixed(2)} ${upAndDownRate}`;
        } else if (displayFormat === 'price-arrow') {
            const arrow = isUp ? '▲' : (isDown ? '▼' : '—');
            panelText = `${price.toFixed(2)} ${arrow}`;
        }

        if (onBattery && batterySaving) {
            panelText += ' [省电]';
        } else if (tradeHoursOnly && !market.isOpen) {
            panelText += ' [休市]';
        }

        this._priceLabel.set_text(panelText);
        this._priceLabel.remove_style_class_name('gold-color-up');
        this._priceLabel.remove_style_class_name('gold-color-down');
        this._priceLabel.remove_style_class_name('gold-color-flat');
        this._priceLabel.add_style_class_name(activeColorClass);

        // 2. 菜单行情卡片更新
        this._menuPriceLabel.set_text(price.toFixed(2));
        this._menuPriceLabel.remove_style_class_name('gold-color-up');
        this._menuPriceLabel.remove_style_class_name('gold-color-down');
        this._menuPriceLabel.remove_style_class_name('gold-color-flat');
        this._menuPriceLabel.add_style_class_name(activeColorClass);

        const sign = upAndDownAmt > 0 ? '+' : '';
        this._menuBadgeLabel.set_text(`${sign}${upAndDownAmt.toFixed(2)} (${upAndDownRate})`);
        this._menuBadgeLabel.remove_style_class_name('gold-color-up');
        this._menuBadgeLabel.remove_style_class_name('gold-color-down');
        this._menuBadgeLabel.remove_style_class_name('gold-color-flat');
        this._menuBadgeLabel.add_style_class_name(activeColorClass);

        this._menuYesterdayLabel.set_text(`昨日收盘: ${yesterdayPrice.toFixed(2)} 元/g`);
        this._menuTimeLabel.set_text(`行情时间: ${timeStr}`);

        if (this._menuRefreshTimeLabel) {
            let refreshStr = '--:--:--';
            if (this._lastRefreshTime) {
                refreshStr = this._lastRefreshTime.toTimeString().split(' ')[0];
            }
            this._menuRefreshTimeLabel.set_text(`最后刷新: ${refreshStr}`);
        }

        if (this._menuRefreshStateLabel) {
            if (onBattery && batterySaving) {
                this._menuRefreshStateLabel.set_text('⏸ 省电暂停');
            } else if (tradeHoursOnly && !market.isOpen) {
                this._menuRefreshStateLabel.set_text('⏸ 休市暂停');
            } else {
                this._menuRefreshStateLabel.set_text('● 正常轮询');
            }
        }

        // 3. 持仓盈亏计算更新
        const grams = this._settings.get_double('holding-grams');
        const cost = this._settings.get_double('cost-price');

        if (grams > 0) {
            const marketValue = grams * price;
            const todayPnL = grams * upAndDownAmt;

            this._holdingValLabel.set_text(`¥ ${marketValue.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${grams.toFixed(4)}g)`);

            // 今日收益: 格式统一定制为 ¥ +-金额
            let todayText = '¥ 0.00';
            if (todayPnL > 0) {
                todayText = `¥ +${todayPnL.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
            } else if (todayPnL < 0) {
                todayText = `¥ -${Math.abs(todayPnL).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
            }
            this._todayPnLLabel.set_text(todayText);
            this._todayPnLLabel.remove_style_class_name('gold-color-up');
            this._todayPnLLabel.remove_style_class_name('gold-color-down');
            this._todayPnLLabel.remove_style_class_name('gold-color-flat');
            if (todayPnL > 0) this._todayPnLLabel.add_style_class_name(upClass);
            else if (todayPnL < 0) this._todayPnLLabel.add_style_class_name(downClass);
            else this._todayPnLLabel.add_style_class_name('gold-color-flat');

            // 累计盈亏: 格式统一定制为 ¥ +-金额
            if (cost > 0) {
                const totalPnL = grams * (price - cost);
                const totalPnLRate = ((price - cost) / cost) * 100;

                let totalText = '¥ 0.00 (0.00%)';
                if (totalPnL > 0) {
                    totalText = `¥ +${totalPnL.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (+${totalPnLRate.toFixed(2)}%)`;
                } else if (totalPnL < 0) {
                    totalText = `¥ -${Math.abs(totalPnL).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (-${Math.abs(totalPnLRate).toFixed(2)}%)`;
                }
                this._totalPnLLabel.set_text(totalText);
                this._totalPnLLabel.remove_style_class_name('gold-color-up');
                this._totalPnLLabel.remove_style_class_name('gold-color-down');
                this._totalPnLLabel.remove_style_class_name('gold-color-flat');
                if (totalPnL > 0) this._totalPnLLabel.add_style_class_name(upClass);
                else if (totalPnL < 0) this._totalPnLLabel.add_style_class_name(downClass);
                else this._totalPnLLabel.add_style_class_name('gold-color-flat');
            } else {
                this._totalPnLLabel.set_text('未设成本');
                this._totalPnLLabel.remove_style_class_name('gold-color-up');
                this._totalPnLLabel.remove_style_class_name('gold-color-down');
                this._totalPnLLabel.add_style_class_name('gold-color-flat');
            }
        } else {
            this._holdingValLabel.set_text('¥ 0.00');
            this._todayPnLLabel.set_text('¥ 0.00');
            this._totalPnLLabel.set_text('未持仓');
            this._todayPnLLabel.remove_style_class_name('gold-color-up');
            this._todayPnLLabel.remove_style_class_name('gold-color-down');
            this._todayPnLLabel.add_style_class_name('gold-color-flat');
            this._totalPnLLabel.remove_style_class_name('gold-color-up');
            this._totalPnLLabel.remove_style_class_name('gold-color-down');
            this._totalPnLLabel.add_style_class_name('gold-color-flat');
        }
    }

    destroy() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }

        if (this._cancellable) {
            this._cancellable.cancel();
        }

        if (this._httpSession) {
            this._httpSession.abort();
            this._httpSession = null;
        }

        this._settingsSignals.forEach(id => this._settings.disconnect(id));
        this._settingsSignals = [];

        if (this._powerSignalId && this._powerProxy) {
            this._powerProxy.disconnect(this._powerSignalId);
            this._powerSignalId = 0;
        }
        this._powerProxy = null;

        if (this._holidayManager) {
            this._holidayManager.destroy();
            this._holidayManager = null;
        }

        super.destroy();
    }
});

export default class GoldPriceTrackerExtension extends Extension {
    enable() {
        this._indicator = new GoldIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
