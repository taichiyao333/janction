/**
 * ポイントプラン定義（共通モジュール）
 * points.js / stripe.js の両方からこの定義を使う
 */

const POINT_RATE = 10; // 1 point = 10 yen

const TICKET_PLANS = [
    { id: 'plan_1h',   name: '1時間チケット',   hours: 1,   price_per_hour: 800, discount: 0,  badge: '' },
    { id: 'plan_3h',   name: '3時間チケット',   hours: 3,   price_per_hour: 800, discount: 0,  badge: '' },
    { id: 'plan_10h',  name: '10時間チケット',  hours: 10,  price_per_hour: 750, discount: 6,  badge: '💡 おすすめ' },
    { id: 'plan_30h',  name: '30時間チケット',  hours: 30,  price_per_hour: 700, discount: 12, badge: '🔥 人気' },
    { id: 'plan_100h', name: '100時間チケット', hours: 100, price_per_hour: 650, discount: 18, badge: '👑 ベスト' },
];

/**
 * プランの金額・ポイント数を計算
 */
function calcPlan(plan) {
    const amount_yen = Math.round(plan.hours * plan.price_per_hour);
    const points = amount_yen / POINT_RATE;
    return { ...plan, amount_yen, points };
}

/**
 * プランIDからプランオブジェクトを取得（計算済み）
 */
function getPlanById(planId) {
    const plan = TICKET_PLANS.find(p => p.id === planId);
    return plan ? calcPlan(plan) : null;
}

/**
 * Stripe Checkout 用のプランMapを返す
 * { plan_1h: { name, hours, amount_yen, points }, ... }
 */
function getStripePlansMap() {
    const map = {};
    TICKET_PLANS.forEach(p => {
        const calc = calcPlan(p);
        map[p.id] = {
            name: calc.name,
            hours: calc.hours,
            amount_yen: calc.amount_yen,
            points: calc.points,
        };
    });
    return map;
}

module.exports = {
    POINT_RATE,
    TICKET_PLANS,
    calcPlan,
    getPlanById,
    getStripePlansMap,
};
