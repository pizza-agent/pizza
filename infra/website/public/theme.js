try { const theme = localStorage.getItem('pizza-site-theme'); if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme; } catch {}
