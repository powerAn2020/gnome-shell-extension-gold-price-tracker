import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class GoldPriceTrackerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // 创建主偏好页面
        const page = new Adw.PreferencesPage({
            title: '黄金行情偏好设置',
            icon_name: 'accessories-calculator-symbolic',
        });
        window.add(page);

        // ========== 1. 顶栏展示与刷新分组 ==========
        const displayGroup = new Adw.PreferencesGroup({
            title: '顶栏展示与刷新',
            description: '配置系统面板上的金价展示格式及更新频率',
        });
        page.add(displayGroup);

        // 图标开关
        const iconRow = new Adw.SwitchRow({
            title: '显示金币图标',
            subtitle: '在价格前显示 🪙 标识',
        });
        settings.bind('show-icon', iconRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(iconRow);

        // 顶栏显示格式 ComboRow
        const formatOptions = [
            { id: 'price-rate', label: '现价 + 今日涨跌幅' },
            { id: 'price-arrow', label: '现价 + 涨跌指示箭头' },
            { id: 'price-only', label: '仅显示现价' },
        ];
        const formatModel = new Gtk.StringList();
        formatOptions.forEach(opt => formatModel.append(opt.label));

        const currentFormat = settings.get_string('display-format');
        const currentFormatIdx = Math.max(0, formatOptions.findIndex(o => o.id === currentFormat));

        const formatRow = new Adw.ComboRow({
            title: '顶栏显示格式',
            subtitle: '自定义系统面板上的文本呈现样式',
            model: formatModel,
            selected: currentFormatIdx,
        });
        formatRow.connect('notify::selected', () => {
            const selectedOpt = formatOptions[formatRow.selected];
            if (selectedOpt) {
                settings.set_string('display-format', selectedOpt.id);
            }
        });
        displayGroup.add(formatRow);

        // 配色模式 ComboRow
        const colorOptions = [
            { id: 'red-up-green-down', label: '红涨绿跌' },
            { id: 'green-up-red-down', label: '绿涨红跌' },
        ];
        const colorModel = new Gtk.StringList();
        colorOptions.forEach(opt => colorModel.append(opt.label));

        const currentColor = settings.get_string('color-scheme');
        const currentColorIdx = Math.max(0, colorOptions.findIndex(o => o.id === currentColor));

        const colorRow = new Adw.ComboRow({
            title: '涨跌配色方案',
            subtitle: '切换上涨与下跌时对应的视觉高亮颜色',
            model: colorModel,
            selected: currentColorIdx,
        });
        colorRow.connect('notify::selected', () => {
            const selectedOpt = colorOptions[colorRow.selected];
            if (selectedOpt) {
                settings.set_string('color-scheme', selectedOpt.id);
            }
        });
        displayGroup.add(colorRow);

        // 刷新间隔 SpinRow
        const refreshRow = new Adw.SpinRow({
            title: '自动刷新频率（秒）',
            subtitle: '定时请求浙商积存金接口的间隔秒数（1 ~ 600秒）',
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 600,
                step_increment: 1,
                page_increment: 10,
                value: settings.get_int('refresh-interval'),
            }),
        });
        settings.bind('refresh-interval', refreshRow.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(refreshRow);

        // ========== 2. 持仓盈亏估算设置 ==========
        const holdingsGroup = new Adw.PreferencesGroup({
            title: '持仓与收益计算',
            description: '配置你的持仓克数与成本均价，插件将自动计算实时总市值、今日收益及累计盈亏',
        });
        page.add(holdingsGroup);

        // 持仓克数
        const gramsRow = new Adw.SpinRow({
            title: '持仓黄金克数（克 / g）',
            subtitle: '输入当前持有的黄金克数，设为 0 则不统计',
            digits: 4,
            adjustment: new Gtk.Adjustment({
                lower: 0.0,
                upper: 100000.0,
                step_increment: 0.0001,
                page_increment: 1.0,
                value: settings.get_double('holding-grams'),
            }),
        });
        settings.bind('holding-grams', gramsRow.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
        holdingsGroup.add(gramsRow);

        // 买入成本均价
        const costRow = new Adw.SpinRow({
            title: '买入均价成本（元 / 克）',
            subtitle: '输入你的持仓平均成本，用于实时估算累计盈亏与收益率',
            digits: 2,
            adjustment: new Gtk.Adjustment({
                lower: 0.0,
                upper: 10000.0,
                step_increment: 1.0,
                page_increment: 10.0,
                value: settings.get_double('cost-price'),
            }),
        });
        settings.bind('cost-price', costRow.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
        holdingsGroup.add(costRow);

        // ========== 3. 省电与开市策略设置 ==========
        const strategyGroup = new Adw.PreferencesGroup({
            title: '省电与开市策略',
            description: '智能控制数据拉取时机，降低后台网络与电量消耗',
        });
        page.add(strategyGroup);

        // 开市时间限制
        const tradeRow = new Adw.SwitchRow({
            title: '仅在开市时间请求',
            subtitle: '联动中国法定节假日与黄金交易所交易时段，休市期间暂停自动轮询',
        });
        settings.bind('trade-hours-only', tradeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        strategyGroup.add(tradeRow);

        // 电池省电模式
        const batteryRow = new Adw.SwitchRow({
            title: '电池供电时暂停刷新',
            subtitle: '检测到笔记本使用电池供电时自动暂停后台轮询，节约电量',
        });
        settings.bind('battery-saving', batteryRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        strategyGroup.add(batteryRow);

        // ========== 4. 开市交易时段配置 ==========
        const hoursGroup = new Adw.PreferencesGroup({
            title: '开市交易时段配置',
            description: '自定义开市时段（格式如 09:00-11:30，留空则不开启对应时段）',
        });
        page.add(hoursGroup);

        // 早盘时段
        const morningRow = new Adw.EntryRow({
            title: '早盘交易时段',
            text: settings.get_string('morning-session'),
        });
        settings.bind('morning-session', morningRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        hoursGroup.add(morningRow);

        // 午盘时段
        const afternoonRow = new Adw.EntryRow({
            title: '午盘交易时段',
            text: settings.get_string('afternoon-session'),
        });
        settings.bind('afternoon-session', afternoonRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        hoursGroup.add(afternoonRow);

        // 夜盘时段
        const nightRow = new Adw.EntryRow({
            title: '夜盘交易时段',
            text: settings.get_string('night-session'),
        });
        settings.bind('night-session', nightRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        hoursGroup.add(nightRow);

        // 恢复默认按钮
        const resetRow = new Adw.ActionRow({
            title: '恢复默认开市时段',
            subtitle: '重置为上海黄金交易所标准（09:00-11:30 / 13:30-15:30 / 20:00-02:30）',
        });
        const resetBtn = new Gtk.Button({
            label: '恢复默认',
            valign: Gtk.Align.CENTER,
        });
        resetBtn.connect('clicked', () => {
            settings.set_string('morning-session', '09:00-11:30');
            settings.set_string('afternoon-session', '13:30-15:30');
            settings.set_string('night-session', '20:00-02:30');
        });
        resetRow.add_suffix(resetBtn);
        hoursGroup.add(resetRow);
    }
}
