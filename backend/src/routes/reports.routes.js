const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const requireFeature = require('../middleware/requireFeature');
const ctrl = require('../controllers/reports.controller');

// The report library: generate, keep, re-run, export. See the controller.
const router = Router();
router.use(authenticate);
router.use(requireFeature('reports')); // the Reports page (account switch)

router.get   ('/',            ctrl.listReports);
router.get   ('/preview',     ctrl.previewReport);   // before '/:id'
router.get   ('/preview/pdf', ctrl.exportPreviewPdf);
router.post  ('/',            ctrl.createReport);
router.get   ('/:id',         ctrl.getReport);
router.get   ('/:id/csv',     ctrl.exportCsv);
router.get   ('/:id/pdf',     ctrl.exportPdf);
router.post  ('/:id/rerun',   ctrl.rerunReport);
router.delete('/:id',         ctrl.deleteReport);

module.exports = router;
