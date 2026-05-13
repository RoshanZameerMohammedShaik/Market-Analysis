// Tiny SVG sparkline renderer. ~1 KB output per card.
// Inputs: array of numbers. Outputs: <svg> string ready to dump into innerHTML.

export function sparkline(values, { width = 110, height = 28, stroke = 'currentColor' } = {}) {
    if (!values || values.length < 2) return '';
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const stepX = width / (values.length - 1);

    const points = values.map((v, i) => {
        const x = i * stepX;
        const y = height - ((v - min) / range) * height;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');

    // Direction tint: green if last > first, red otherwise.
    const isUp = values[values.length - 1] >= values[0];
    const cls = isUp ? 'spark-up' : 'spark-down';

    // Soft area fill under the line for visual weight at small sizes.
    const areaPoints = `0,${height} ${points} ${width},${height}`;
    return `<svg class="sparkline ${cls}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" width="100%" height="${height}" aria-hidden="true">
        <polygon points="${areaPoints}" class="spark-area"/>
        <polyline points="${points}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>`;
}
