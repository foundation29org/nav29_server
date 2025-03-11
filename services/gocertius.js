'use strict'

const axios = require('axios');
const insights = require('../services/insights')
const config = require('../config')

async function getToken(req, res) {
  const tokenUrl = config.GOCERTIUS.TOKEN_URL;
  const data = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.GOCERTIUS.CLIENT_ID,
    client_secret: config.GOCERTIUS.CLIENT_SECRET,
    scope: 'token'
  });

  try {
    const response = await axios.post(tokenUrl, data, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    res.status(200).json(response.data);
  } catch (error) {
    console.error('Error al obtener el token:', error);
    insights.error(error);
    res.status(500).json({ message: 'Error al obtener el token' });
  }
}

async function createCasefile(req, res) {
	try {
	  //get the token from Authorization', `Bearer ${token}
	  const token = req.get('X-Gocertius-Token');
	  const caseFileData = req.body;
	  const response = await axios.post(
		`${config.GOCERTIUS.API_URL}/api/v1/private/case-files`,
		caseFileData,
		{
		  headers: {
			'Authorization': `Bearer ${token}`,
			'Content-Type': 'application/json'
		  }
		}
	  );
  
	  res.status(201).json(response.data);
	} catch (error) {
		
	  //console.error('Error al crear el Case File:', error);
	  //insights.error(error);
	  if(error.response.data){
			console.log(error.response.data.errors);
		}
		res.status(error.response?.status || 500).json({ 
			message: 'Error al crear el Case File', 
		error: error.response?.data || error.message 
	  });
	}
  }


  async function getCasefile(req, res) {
	try {
	  const token = req.get('X-Gocertius-Token');
	  const response = await axios.get(
		`${config.GOCERTIUS.API_URL}/api/v1/private/case-files/${req.params.caseFileId}`,
		{
		  headers: {
			'Authorization': `Bearer ${token}`,
			'Content-Type': 'application/json'
		  }
		}
	  );
  
	  res.status(200).json(response.data);
	} catch (error) {
	  console.error('Error al obtener el Case File:', error);
	  insights.error(error);
	  res.status(error.response?.status || 500).json({ 
		message: 'Error al obtener el Case File', 
		error: error.response?.data || error.message 
	  });
	}
  }

async function updateCasefile(req, res) {
	try {
	  const token = req.get('X-Gocertius-Token');
	  const caseFileData = req.body;
	  const response = await axios.patch(
		`${config.GOCERTIUS.API_URL}/api/v1/private/case-files/${req.params.caseFileId}`,
		caseFileData,
		{
		  headers: {
			'Authorization': `Bearer ${token}`,
			'Content-Type': 'application/json'
		  }
		}
	  );

	  res.status(200).json(response.data);
	} catch (error) {
	  console.error('Error al actualizar el Case File:', error);
	  insights.error(error);
	  res.status(error.response?.status || 500).json({ 
		message: 'Error al actualizar el Case File', 
		error: error.response?.data || error.message 
	  });
	}
  }

  async function createEvidenceGroup(req, res) {
	try {
	  const token = req.get('X-Gocertius-Token');
	  const evidenceGroupData = req.body;
	  const response = await axios.post(
		`${config.GOCERTIUS.API_URL}/api/v1/private/case-files/${req.params.caseFileId}/evidence-groups`,
		evidenceGroupData,
		{
		  headers: {
			'Authorization': `Bearer ${token}`,
			'Content-Type': 'application/json'
		  }
		}
	  );
  
	  res.status(201).json(response.data);
	} catch (error) {
	  console.error('Error al crear el Evidence Group:', error);
	  insights.error(error);
	  res.status(error.response?.status || 500).json({ 
		message: 'Error al crear el Evidence Group', 
		error: error.response?.data || error.message 
	  });
	}
  }

  async function createEvidence(req, res) {
	try {
	  const token = req.get('X-Gocertius-Token');
	  const evidenceData = req.body;
	  const response = await axios.post(
		`${config.GOCERTIUS.API_URL}/api/v1/private/case-files/${req.params.caseFileId}/evidence-groups/${req.params.evidenceGroupId}/evidences`,
		evidenceData,
		{
		  headers: {
			'Authorization': `Bearer ${token}`,
			'Content-Type': 'application/json'
		  }
		}
	  );
	  res.status(201).json(response.data);
	} catch (error) {
	  console.error('Error al crear el Evidence:', error);
	  insights.error(error);
	  res.status(error.response?.status || 500).json({ 
		message: 'Error al crear el Evidence', 
		error: error.response?.data || error.message 
	  });
	}
  }

  //GET /api/v1/private/case-files/{caseFileId}/evidence-groups/{evidenceGroupId}/evidences/{evidenceId}/upload-url
  async function getEvidenceUploadUrl(req, res) {
	try {
	  const token = req.get('X-Gocertius-Token');
	  const { caseFileId, evidenceGroupId, evidenceId } = req.params;
	  const response = await axios.get(
		`${config.GOCERTIUS.API_URL}/api/v1/private/case-files/${caseFileId}/evidence-groups/${evidenceGroupId}/evidences/${evidenceId}/upload-url`,
		{
		  headers: {
			'Authorization': `Bearer ${token}`,
			'Content-Type': 'application/json'
		  }
		}
	  );
  
	  res.status(200).json(response.data);
	} catch (error) {
		console.error('Error al obtener el Evidence Upload Url:', error);
		insights.error(error);
		res.status(error.response?.status || 500).json({ 
			message: 'Error al obtener el Evidence Upload Url', 
			error: error.response?.data || error.message 
		});
	}
  }

  //Get “Evidence” list GET /api/v1/private/evidences
  async function getEvidenceList(req, res) {
	try {
	  const token = req.get('X-Gocertius-Token');
	  const response = await axios.get(
		`${config.GOCERTIUS.API_URL}/api/v1/private/evidences`,
		{
		  headers: {
			'Authorization': `Bearer ${token}`,
			'Content-Type': 'application/json'
		  }
		}
	  );
  
	  res.status(200).json(response.data);
	} catch (error) {
	  console.error('Error al obtener el Evidence List:', error);
	  insights.error(error);
	  res.status(error.response?.status || 500).json({ 
		message: 'Error al obtener el Evidence List', 
		error: error.response?.data || error.message 
	  });
	}
  }

  //Get “Evidence Group” GET /api/v1/private/evidence-groups/{evidenceGroupId}
  async function getEvidenceGroup(req, res) {
	try {
	  const token = req.get('X-Gocertius-Token');
	  const { caseFileId, evidenceGroupId } = req.params;
	  const response = await axios.get(
		`${config.GOCERTIUS.API_URL}/api/v1/private/case-files/${caseFileId}/evidence-groups/${evidenceGroupId}`,
		{
		  headers: {
			'Authorization': `Bearer ${token}`,
			'Content-Type': 'application/json'
		  }
		}
	  );
  
	  res.status(200).json(response.data);
	} catch (error) {
	  console.error('Error al obtener el Evidence Group:', error);
	  insights.error(error);
	  res.status(error.response?.status || 500).json({ 
		message: 'Error al obtener el Evidence Group', 
		error: error.response?.data || error.message 
	  });
	}
  }

  async function getEvidenceGroupList(req, res) {
	try {
	  const token = req.get('X-Gocertius-Token');
	  const response = await axios.get(
		`${config.GOCERTIUS.API_URL}/api/v1/private/evidence-groups`,
		{
		  headers: {
			'Authorization': `Bearer ${token}`,
			'Content-Type': 'application/json'
		  }
		}
	  );
  
	  res.status(200).json(response.data);
	} catch (error) {
	  console.error('Error al obtener el Evidence Group List:', error);
	  insights.error(error);
	  res.status(error.response?.status || 500).json({ 
		message: 'Error al obtener el Evidence Group List', 
		error: error.response?.data || error.message 
	  });
	}
  }
			

  async function closeEvidenceGroup(req, res) {
	try {
	  const token = req.get('X-Gocertius-Token');
	  const { caseFileId, evidenceGroupId } = req.params;
	  const data = req.body;
	  const response = await axios.post(
		`${config.GOCERTIUS.API_URL}/api/v1/private/case-files/${caseFileId}/evidence-groups/${evidenceGroupId}/close`,
		data,
		{
		  headers: {
			'Authorization': `Bearer ${token}`,
			'Content-Type': 'application/json'
		  }
		}
	  );
  
	  res.status(200).json(response.data);
	} catch (error) {
		console.error('Error al cerrar el Evidence Group:', error);
		insights.error(error);
		res.status(error.response?.status || 500).json({ 
			message: 'Error al cerrar el Evidence Group', 
			error: error.response?.data || error.message 
		});
	}
}

async function generateReport(req, res) {
	try {
		const token = req.get('X-Gocertius-Token');
		const { caseFileId } = req.params;
		const data = req.body;
		let url = `${config.GOCERTIUS.API_URL}/api/v1/private/case-files/${caseFileId}/reports`;
		const response = await axios.post(
			`${config.GOCERTIUS.API_URL}/api/v1/private/case-files/${caseFileId}/reports`,
			data,
			{
				headers: {
					'Authorization': `Bearer ${token}`,
					'Content-Type': 'application/json'
				}
			}
		);

		res.status(200).json(response.data);
	} catch (error) {
		console.error('Error al generar el Report:', error);
		insights.error(error);
		res.status(error.response?.status || 500).json({ 
			message: 'Error al generar el Report', 
			error: error.response?.data || error.message 
		});
	}
}

async function getReportPdfUrl(req, res) {
	try {
		const token = req.get('X-Gocertius-Token');
		const { reportId } = req.params;
		console.log(reportId);
		const response = await axios.get(
			`${config.GOCERTIUS.API_URL}/api/v1/private/reports/${reportId}/document`,
			{
				headers: {
					'Authorization': `Bearer ${token}`,
					'Content-Type': 'application/json'
				}
			}
		);

		res.status(200).json(response.data);
	} catch (error) {
		console.error('Error al obtener el Report PDF URL:', error);
		insights.error(error);
		res.status(error.response?.status || 500).json({ 
			message: 'Error al obtener el Report PDF URL', 
			error: error.response?.data || error.message 
		});
	}
}

async function getReportZip(req, res) {
	try {
		const token = req.get('X-Gocertius-Token');
		const { reportId } = req.params;
		const response = await axios.get(
			`${config.GOCERTIUS.API_URL}/api/v1/private/reports/${reportId}/package`,
			{
				headers: {
					'Authorization': `Bearer ${token}`,
					'Content-Type': 'application/json'
				}
			}
		);

		res.status(200).json(response.data);
	} catch (error) {
		console.error('Error al obtener el Report ZIP:', error);
		insights.error(error);
		res.status(error.response?.status || 500).json({ 
			message: 'Error al obtener el Report ZIP', 
			error: error.response?.data || error.message 
		});
	}
}

module.exports = {
	getToken,
	createCasefile,
	getCasefile,
	updateCasefile,
	createEvidenceGroup,
	createEvidence,
	getEvidenceUploadUrl,
	getEvidenceList,
	getEvidenceGroup,
	getEvidenceGroupList,
	closeEvidenceGroup,
	generateReport,
	getReportPdfUrl,
	getReportZip
}
