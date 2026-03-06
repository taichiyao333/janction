const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');
const { mailReservationConfirmed } = require('../services/email');

// GET /api/reservations - my reservations (or all for admin)
router.get('/', authMiddleware, (req, res) => {
  const db = getDb();
  let reservations;
  if (req.user.role === 'admin') {
    reservations = db.prepare(`
      SELECT r.*, u.username as renter_name, gn.name as gpu_name, gn.price_per_hour
      FROM reservations r
      JOIN users u ON r.renter_id = u.id
      JOIN gpu_nodes gn ON r.gpu_id = gn.id
      ORDER BY r.created_at DESC
    `).all();
  } else {
    reservations = db.prepare(`
      SELECT r.*, gn.name as gpu_name, gn.price_per_hour, gn.location
      FROM reservations r
      JOIN gpu_nodes gn ON r.gpu_id = gn.id
      WHERE r.renter_id = ?
      ORDER BY r.created_at DESC
    `).all(req.user.id);
  }
  res.json(reservations);
});

// POST /api/reservations - create new reservation
router.post('/', authMiddleware, (req, res) => {
  const { gpu_id, start_time, end_time, notes } = req.body;
  if (!gpu_id || !start_time || !end_time)
    return res.status(400).json({ error: 'gpu_id, start_time, end_time required' });

  const start = new Date(start_time);
  const end = new Date(end_time);
  if (start >= end) return res.status(400).json({ error: 'end_time must be after start_time' });
  if (start < new Date()) return res.status(400).json({ error: 'Cannot book in the past' });

  const db = getDb();

  // Check GPU exists
  const gpu = db.prepare('SELECT * FROM gpu_nodes WHERE id = ? AND status != ?').get(gpu_id, 'maintenance');
  if (!gpu) return res.status(404).json({ error: 'GPU not available' });

  // Check for overlapping reservations
  const overlap = db.prepare(`
    SELECT id FROM reservations
    WHERE gpu_id = ?
    AND status NOT IN ('cancelled', 'completed')
    AND NOT (datetime(end_time) <= datetime(?) OR datetime(start_time) >= datetime(?))
  `).get(gpu_id, start_time, end_time);

  if (overlap) return res.status(409).json({ error: 'This time slot is already reserved' });

  // Calculate total price
  const durationHours = (end - start) / 3600000;
  const total_price = durationHours * gpu.price_per_hour;

  const result = db.prepare(`
    INSERT INTO reservations (renter_id, gpu_id, start_time, end_time, status, total_price, notes)
    VALUES (?, ?, ?, ?, 'confirmed', ?, ?)
  `).run(req.user.id, gpu_id, start_time, end_time, total_price, notes || '');

  const reservation = db.prepare('SELECT * FROM reservations WHERE id = ?').get(result.lastInsertRowid);
  const resWithGpu = { ...reservation, gpu_name: gpu.name };

  // 予約確定メールを非同期送信
  const user = db.prepare('SELECT username, email FROM users WHERE id = ?').get(req.user.id);
  if (user?.email) {
    mailReservationConfirmed({ to: user.email, username: user.username, reservation: resWithGpu })
      .catch(e => console.error('Reservation mail error:', e.message));
  }

  res.status(201).json(resWithGpu);
});


// DELETE /api/reservations/:id - cancel
router.delete('/:id', authMiddleware, (req, res) => {
  const db = getDb();
  const reservation = db.prepare('SELECT * FROM reservations WHERE id = ?').get(req.params.id);
  if (!reservation) return res.status(404).json({ error: 'Not found' });
  if (reservation.renter_id !== req.user.id && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Forbidden' });
  if (reservation.status === 'active')
    return res.status(400).json({ error: 'Cannot cancel active session. Stop the pod first.' });

  db.prepare("UPDATE reservations SET status = 'cancelled' WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// GET /api/reservations/active-pod - get my active pod
router.get('/my/active-pod', authMiddleware, (req, res) => {
  const db = getDb();
  const pod = db.prepare(`
    SELECT p.*, gn.name as gpu_name, gn.device_index, r.start_time, r.end_time
    FROM pods p
    JOIN gpu_nodes gn ON p.gpu_id = gn.id
    JOIN reservations r ON p.reservation_id = r.id
    WHERE p.renter_id = ? AND p.status = 'running'
    LIMIT 1
  `).get(req.user.id);
  res.json(pod || null);
});

module.exports = router;
