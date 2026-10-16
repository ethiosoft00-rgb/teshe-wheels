function applyWheelState() {
    const wheel = document.getElementById('wheel');
    if (!wheel) return;
    const s = SETTINGS;
    const target = Number(s.target_rotation || 0);
    const timerEl = document.getElementById('timer');
    if (!timerEl) return;

    // ── SPINNING ──
    if (s.round_state === 'spinning') {
        const startedAt = new Date(s.spin_started_at).getTime();
        const duration = Number(s.duration_seconds) || 30;
        const spinKey = s.round_number + ':' + s.spin_started_at;

        if (wheel._spinKey !== spinKey) {
            wheel._spinKey = spinKey;
            wheel.style.transition = 'none';
            wheel.style.transform = 'rotate(0deg)';
            void wheel.offsetWidth;   // force browser to register the reset
            requestAnimationFrame(() => {
                wheel.style.transition = 'transform ' + duration + 's cubic-bezier(.17,.67,.35,1)';
                wheel.style.transform = 'rotate(' + (360 * 5 + target) + 'deg)';
            });
            const pointer = document.getElementById('topPointer');
            if (pointer) pointer.classList.remove('winner');
            const center = document.getElementById('wheelCenter');
            if (center) center.textContent = 'SPINNING';
        }

        timerEl.classList.remove('sales');
        timerEl.classList.add('spinning');
        startCountdown(startedAt, duration);
        return;
    }

    // ── SALES OPEN ──
    if (s.round_state === 'idle' && s.sales_state === 'open') {
        timerEl.classList.remove('spinning');
        timerEl.classList.add('sales');
        startSalesCountdown(new Date(s.sales_started_at).getTime(), s.sales_duration || 120);
        const center = document.getElementById('wheelCenter');
        if (center) center.textContent = 'READY';
        return;
    }

    // ── IDLE ──
    if (s.round_state === 'idle' && s.sales_state !== 'open') {
        stopCountdown();
        wheel._spinKey = null;
        wheel.style.transition = 'none';
        wheel.style.transform = 'rotate(0deg)';
        const pointer = document.getElementById('topPointer');
        if (pointer) pointer.classList.remove('winner');
        const center = document.getElementById('wheelCenter');
        if (center) center.textContent = 'SPIN';
        const area = document.getElementById('winnerArea');
        if (area) area.innerHTML = '';
        timerEl.classList.remove('spinning', 'sales');
        timerEl.textContent = formatTime(s.duration_seconds);
        return;
    }

    // ── FINISHED ──
    if (s.round_state === 'finished') {
        stopCountdown();
        timerEl.classList.remove('spinning', 'sales');
        wheel._spinKey = null;
        wheel.style.transition = 'none';
        wheel.style.transform = 'rotate(' + target + 'deg)';
        const pointer = document.getElementById('topPointer');
        if (pointer) pointer.classList.add('winner');
        const winners = s.winner_numbers || [];
        const center = document.getElementById('wheelCenter');
        if (center) center.innerHTML = winners.length ? '🏆<br>#' + winners[0] : 'DONE';
        timerEl.textContent = '00:00';
        const statusEl = document.getElementById('status');
        if (statusEl) statusEl.textContent = 'Round completed.';
        showWinners(s.winners || []);
        return;
    }
}