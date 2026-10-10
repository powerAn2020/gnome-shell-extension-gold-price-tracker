import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

export class HolidayManager {
    constructor(settings = null) {
        this._settings = settings;
        this._holidayMap = new Map();
        this._currentYear = new Date().getFullYear();
        this._httpSession = new Soup.Session();
        this._httpSession.timeout = 10;

        this._loadCacheOrFetch();
    }

    _getCacheFilePath(year) {
        const cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'gold-price-tracker']);
        GLib.mkdir_with_parents(cacheDir, 0o755);
        return GLib.build_filenamev([cacheDir, `holidays_${year}.json`]);
    }

    _loadCacheOrFetch() {
        const year = this._currentYear;
        const filePath = this._getCacheFilePath(year);

        // 1. 尝试从本地缓存读取
        if (GLib.file_test(filePath, GLib.FileTest.EXISTS)) {
            try {
                const [ok, bytes] = GLib.file_get_contents(filePath);
                if (ok) {
                    const decoder = new TextDecoder('utf-8');
                    const json = JSON.parse(decoder.decode(bytes));
                    this._parseDays(json);
                    return;
                }
            } catch (e) {
                console.warn(`[GoldTracker] 读取节假日缓存失败: ${e.message}`);
            }
        }

        // 2. 本地无缓存或解析失败，异步联网获取
        this._fetchHolidayData(year, filePath);
    }

    _fetchHolidayData(year, cachePath) {
        const url = `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`;
        const message = Soup.Message.new('GET', url);
        message.request_headers.append('User-Agent', 'Mozilla/5.0');

        this._httpSession.send_and_read_async(
            message,
            GLib.PRIORITY_LOW,
            null,
            (session, res) => {
                try {
                    const bytes = session.send_and_read_finish(res);
                    if (!bytes) return;

                    const decoder = new TextDecoder('utf-8');
                    const text = decoder.decode(bytes.get_data());
                    const json = JSON.parse(text);

                    this._parseDays(json);

                    // 写入本地缓存文件
                    GLib.file_set_contents(cachePath, text);
                } catch (e) {
                    // 即使网络不通也静默兜底，不影响主插件正常工作
                    console.warn(`[GoldTracker] 获取节假日数据失败（将以周末规则兜底）: ${e.message}`);
                }
            }
        );
    }

    _parseDays(data) {
        if (!data || !Array.isArray(data.days)) return;

        this._holidayMap.clear();
        for (const item of data.days) {
            if (item.date) {
                this._holidayMap.set(item.date, {
                    isOffDay: Boolean(item.isOffDay),
                    name: item.name || '法定节假日',
                });
            }
        }
    }

    isOffDay(dateKey) {
        const holiday = this._holidayMap.get(dateKey);
        return holiday ? holiday.isOffDay : false;
    }

    getHolidayName(dateKey) {
        const holiday = this._holidayMap.get(dateKey);
        return holiday && holiday.isOffDay ? holiday.name : null;
    }

    _parseTimeRange(str) {
        if (!str || typeof str !== 'string') return null;
        const parts = str.trim().split('-');
        if (parts.length !== 2) return null;
        const parseHM = (s) => {
            const segs = s.trim().split(':');
            if (segs.length !== 2) return null;
            const h = Number(segs[0]);
            const m = Number(segs[1]);
            if (isNaN(h) || isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
            return h * 60 + m;
        };
        const start = parseHM(parts[0]);
        const end = parseHM(parts[1]);
        if (start === null || end === null) return null;
        return { start, end, crossesMidnight: end < start, label: str.trim() };
    }

    /**
     * 判断当前是否处于开市交易时段（支持自定义早盘/午盘/夜盘时段）
     * @param {Date} now
     * @returns {{ isOpen: boolean, reason: string }}
     */
    isMarketOpen(now = new Date()) {
        // 统一换算为北京时间 (UTC+8)
        const utcMs = now.getTime() + (now.getTimezoneOffset() * 60000);
        const cst = new Date(utcMs + (8 * 3600000));

        const year = cst.getFullYear();
        const month = String(cst.getMonth() + 1).padStart(2, '0');
        const day = String(cst.getDate()).padStart(2, '0');
        const dateKey = `${year}-${month}-${day}`;

        // 跨年时更新年份检查
        if (year !== this._currentYear) {
            this._currentYear = year;
            this._loadCacheOrFetch();
        }

        // 1. 节假日休市检测
        if (this.isOffDay(dateKey)) {
            const name = this.getHolidayName(dateKey) || '节假日';
            return { isOpen: false, reason: `法定节假日休市 (${name})` };
        }

        const dayOfWeek = cst.getDay(); // 0: 周日, 1: 周一, ..., 6: 周六
        const timeVal = cst.getHours() * 60 + cst.getMinutes();

        // 读取用户配置的时段，若无配置则使用默认值
        const morningStr = this._settings ? this._settings.get_string('morning-session') : '09:00-11:30';
        const afternoonStr = this._settings ? this._settings.get_string('afternoon-session') : '13:30-15:30';
        const nightStr = this._settings ? this._settings.get_string('night-session') : '20:00-02:30';

        const morning = this._parseTimeRange(morningStr);
        const afternoon = this._parseTimeRange(afternoonStr);
        const night = this._parseTimeRange(nightStr);

        // 2. 跨日夜盘在次日凌晨的延续检查（如 00:00 - 02:30）
        if (night && night.crossesMidnight && timeVal <= night.end) {
            const endStr = `${String(Math.floor(night.end / 60)).padStart(2, '0')}:${String(night.end % 60).padStart(2, '0')}`;
            if (dayOfWeek >= 2 && dayOfWeek <= 5) {
                return { isOpen: true, reason: `夜盘交易中 (至${endStr})` };
            }
            if (dayOfWeek === 6) {
                return { isOpen: true, reason: `周五夜盘交易中 (至${endStr})` };
            }
        }

        // 3. 周末全天休市
        if (dayOfWeek === 0 || dayOfWeek === 6) {
            return { isOpen: false, reason: '周末休市' };
        }

        // 4. 工作日开市检查
        // 早盘开盘前
        if (morning && timeVal < morning.start) {
            return { isOpen: false, reason: `开市前 (${morning.label.split('-')[0]}开盘)` };
        }

        // 早盘时段
        if (morning && !morning.crossesMidnight && timeVal >= morning.start && timeVal <= morning.end) {
            return { isOpen: true, reason: `早盘交易中 (${morning.label})` };
        }

        // 午盘时段
        if (afternoon && !afternoon.crossesMidnight && timeVal >= afternoon.start && timeVal <= afternoon.end) {
            return { isOpen: true, reason: `午盘交易中 (${afternoon.label})` };
        }

        // 夜盘晚间开始时段
        if (night && night.crossesMidnight && timeVal >= night.start) {
            return { isOpen: true, reason: `夜盘交易中 (${night.label})` };
        }
        if (night && !night.crossesMidnight && timeVal >= night.start && timeVal <= night.end) {
            return { isOpen: true, reason: `夜盘交易中 (${night.label})` };
        }

        // 盘中休市间歇提示
        if (morning && afternoon && timeVal > morning.end && timeVal < afternoon.start) {
            return { isOpen: false, reason: `午间休市 (${morning.label.split('-')[1] || ''}-${afternoon.label.split('-')[0] || ''})` };
        }
        if (afternoon && night && timeVal > afternoon.end && timeVal < night.start) {
            return { isOpen: false, reason: `晚间休市 (${afternoon.label.split('-')[1] || ''}-${night.label.split('-')[0] || ''})` };
        }

        return { isOpen: false, reason: '休市中' };
    }

    destroy() {
        if (this._httpSession) {
            this._httpSession.abort();
            this._httpSession = null;
        }
    }
}
